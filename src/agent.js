import { buildSystemPrompt } from './prompts.js';
import { snapshotFile, saveSession } from './session.js';
import { friendlyProviderError, isAbortError } from './providers/index.js';
import { firstLine, gitInfo, truncateEnd } from './util.js';

const SUMMARY_SYSTEM = `You compress conversation history for a coding agent so it can continue a task with less context. Preserve: the user's intent and constraints, decisions and rationale, files and symbols touched, commands run and their results, unresolved errors, and concrete next steps. Do not invent details. Use terse bullet points grouped under headings. Target 400-900 words.`;

export class Agent {
  constructor({
    config,
    provider,
    session,
    cwd,
    registry,
    ui,
    approvals,
    prompter = null,
    askUser = null,
    shell,
    ignoreRules = [],
    projectInstructions = '',
    interactive = true,
  }) {
    this.config = config;
    this.provider = provider;
    this.session = session;
    this.cwd = cwd;
    this.registry = registry;
    this.ui = ui;
    this.approvals = approvals;
    this.prompter = prompter;
    this.askUser = askUser;
    this.shell = shell;
    this.ignoreRules = ignoreRules;
    this.projectInstructions = projectInstructions;
    this.interactive = interactive;
    this.turnSignal = null;
    this.git = gitInfo(cwd);
    this.lastContextPct = 0;
  }

  get messages() {
    return this.session.messages;
  }

  get model() {
    return this.provider.runtime?.model || '';
  }

  systemPrompt() {
    const tools = this.registry.list();
    const pluginCount = new Set(tools.filter((tool) => tool.plugin).map((tool) => tool.plugin)).size;
    const mcpCount = new Set(tools.filter((tool) => tool.mcpServer).map((tool) => tool.mcpServer)).size;
    return buildSystemPrompt({
      cwd: this.cwd,
      config: this.config,
      shell: this.shell,
      provider: this.provider.runtime?.label || this.provider.runtime?.name || 'provider',
      model: this.model,
      git: this.git,
      projectInstructions: this.projectInstructions,
      pluginCount,
      mcpCount,
    });
  }

  async runTurn(input, { signal = null, title = null } = {}) {
    this.turnSignal = signal;
    const startedAt = Date.now();
    this.ui.beginTurn?.();
    this.session.messages.push({ role: 'user', content: String(input) });
    if (!this.session.title) {
      this.session.title = (title || firstLine(String(input), 90) || 'Untitled session').slice(0, 100);
    }
    this.session.provider = this.provider.runtime?.name || this.session.provider;
    this.session.model = this.model || this.session.model;
    await this.save();

    let finalText = '';
    let completed = false;
    let failure = null;
    let step = 0;
    let retriedContext = false;
    const callGuard = new Map();

    try {
      for (; step < this.config.maxSteps; step += 1) {
        if (signal?.aborted) throw abortError();
        await this.maybeCompact(signal);
        this.ui.thinking?.(step === 0 ? 'thinking' : 'continuing');

        let response;
        try {
          response = await this.provider.chat({
            system: this.systemPrompt(),
            messages: this.messages,
            tools: this.registry.schemas(),
            signal,
            onText: (chunk) => this.ui.assistantDelta?.(chunk),
            onReasoning: () => {},
          });
        } catch (error) {
          if (!retriedContext && isContextLengthError(error)) {
            retriedContext = true;
            this.ui.warn?.('Context limit reached; compacting the conversation and retrying.');
            const compacted = await this.compact({ keep: 4, reason: 'context', signal });
            if (compacted) {
              step -= 1;
              continue;
            }
          }
          throw error;
        }

        this.ui.stopSpinner?.();
        this.ui.endAssistant?.();
        if (signal?.aborted) throw abortError();

        const usage = response.usage;
        if (usage) {
          this.session.usage.input += Number(usage.input) || 0;
          this.session.usage.output += Number(usage.output) || 0;
          this.session.usage.total += Number(usage.total) || (Number(usage.input) + Number(usage.output)) || 0;
        }

        const text = response.text || '';
        if (text) finalText = text;
        const toolCalls = ensureUniqueIds(response.toolCalls || []);
        this.lastContextPct = this.contextPercent();

        if (toolCalls.length === 0) {
          if (text.trim()) {
            this.session.messages.push({ role: 'assistant', content: text });
          } else {
            this.ui.warn?.('The model returned an empty response.');
          }
          await this.save();
          completed = true;
          break;
        }

        this.session.messages.push({
          role: 'assistant',
          content: text,
          toolCalls,
        });
        await this.save();

        for (const call of toolCalls) {
          if (signal?.aborted) throw abortError();
          const result = await this.executeTool(call, signal, callGuard);
          this.session.messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: truncateEnd(result.content || '', this.config.maxToolOutput || 60_000, 'tool output'),
            isError: Boolean(result.isError),
          });
          await this.save();
          if (signal?.aborted) throw abortError();
        }
      }

      if (!completed && step >= this.config.maxSteps) {
        const note = `I stopped after ${this.config.maxSteps} tool steps without finishing. `
          + 'The task may need a narrower request, or the model may be looping.';
        this.ui.warn?.(note);
        finalText = finalText || note;
        this.session.messages.push({ role: 'assistant', content: note });
        await this.save();
      }
      completed = true;
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        this.ui.stopSpinner?.();
        this.ui.endAssistant?.();
        this.ui.warn?.('Cancelled.');
        failure = { aborted: true, message: 'Cancelled.' };
      } else {
        const message = friendlyProviderError(error, this.provider.runtime);
        this.ui.error?.(message);
        failure = { message };
      }
      await this.save();
    } finally {
      this.ui.stopSpinner?.();
      this.ui.endAssistant?.();
      this.lastContextPct = this.contextPercent();
      this.ui.status?.({
        model: this.model,
        usage: this.session.usage,
        contextPct: this.lastContextPct,
        elapsedMs: Date.now() - startedAt,
        approvalMode: this.approvals?.mode || this.config.approvalMode,
      });
      this.ui.endTurn?.();
      this.turnSignal = null;
    }

    return {
      ok: !failure && completed,
      text: finalText,
      error: failure,
    };
  }

  contextPercent() {
    const tokens = this.estimateContextTokens();
    return (tokens / Math.max(1, this.config.contextWindow)) * 100;
  }

  estimateContextTokens() {
    const system = this.systemPrompt();
    const tools = this.registry.schemas();
    let chars = system.length + JSON.stringify(tools).length + 200;
    for (const message of this.messages) {
      chars += typeof message.content === 'string' ? message.content.length : 0;
      if (message.toolCalls) chars += JSON.stringify(message.toolCalls).length;
      chars += 24;
    }
    return Math.ceil(chars / 4);
  }

  async maybeCompact(signal) {
    if (this.messages.length < 12) return false;
    const tokens = this.estimateContextTokens();
    const threshold = this.config.contextWindow * 0.78;
    if (tokens < threshold) return false;
    this.ui.info?.(`Context is ~${tokens.toLocaleString('en-US')} tokens; compacting history.`);
    return this.compact({ keep: 8, reason: 'auto', signal });
  }

  /**
   * Summarize older messages into one note and keep the recent tail.
   * Falls back to dropping old messages if summarization fails.
   */
  async compact({ keep = 8, reason = 'manual', signal = null } = {}) {
    if (this.messages.length <= 4) {
      this.ui.info?.('Nothing to compact yet.');
      return false;
    }
    let keepFrom = Math.max(0, this.messages.length - keep);
    while (keepFrom < this.messages.length && this.messages[keepFrom].role === 'tool') {
      keepFrom += 1;
    }
    const older = this.messages.slice(0, keepFrom);
    if (older.length === 0) {
      this.ui.info?.('Nothing to compact yet.');
      return false;
    }
    const transcript = formatTranscript(older, 160_000);
    const prompt = [
      `Project directory: ${this.cwd}`,
      `Session title: ${this.session.title || '(untitled)'}`,
      `Reason for compaction: ${reason}`,
      '',
      'Conversation to summarize:',
      transcript,
    ].join('\n');

    let summary = '';
    try {
      this.ui.thinking?.('compacting context');
      const response = await this.provider.chat({
        system: SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
        tools: [],
        maxTokens: 2500,
        temperature: 0.1,
        signal,
        onText: () => {},
      });
      summary = (response.text || '').trim();
      if (!summary) throw new Error('The summarizer returned no text.');
    } catch (error) {
      if (isAbortError(error)) {
        this.ui.stopSpinner?.();
        this.ui.warn?.('Compaction cancelled.');
        return false;
      }
      summary = '';
      this.ui.warn?.(`Context summarization failed (${firstLine(error.message, 140)}). Dropping older messages instead.`);
    } finally {
      this.ui.stopSpinner?.();
    }

    const tail = this.messages.slice(keepFrom);
    if (!summary) {
      this.session.messages = [
        {
          role: 'user',
          content: '[Earlier conversation history was dropped because automatic summarization failed. Continue from the recent messages below and ask if important context is missing.]',
        },
        ...tail.slice(-Math.min(tail.length, Math.max(4, keep))),
      ];
    } else {
      this.session.messages = [
        {
          role: 'user',
          content: `[Conversation summary — earlier messages were compacted by Hasty]\n\n${summary}`,
        },
        ...tail,
      ];
    }
    this.session.compactions += 1;
    await this.save();
    this.ui.info?.('History compacted. Recent messages and a summary are kept.');
    return true;
  }

  async executeTool(call, signal, callGuard) {
    const tool = this.registry.get(call.name);
    const started = Date.now();
    const summary = toolActionSummary(call.name, call.arguments);
    this.ui.toolStart?.(call.name, summary);

    if (!tool) {
      const available = this.registry.names();
      const similar = available.filter((name) => name.includes(call.name.split('_')[0])).slice(0, 6);
      const content = `Unknown tool "${call.name}". Available tools: ${similar.length ? similar.join(', ') : available.join(', ')}`;
      this.ui.toolEnd?.({ ok: false, summary: content, durationMs: Date.now() - started });
      return { content, isError: true };
    }

    if (call.parseError) {
      const content = `Tool arguments were not valid JSON (${call.parseError}). Re-issue the call with valid JSON. Raw arguments: ${truncateEnd(call.rawArguments || '', 1000, 'arguments')}`;
      this.ui.toolEnd?.({ ok: false, summary: 'invalid arguments', durationMs: Date.now() - started });
      return { content, isError: true };
    }
    if (call.arguments == null || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
      const content = 'Tool arguments must be a JSON object.';
      this.ui.toolEnd?.({ ok: false, summary: 'invalid arguments', durationMs: Date.now() - started });
      return { content, isError: true };
    }

    const key = `${call.name}:${JSON.stringify(call.arguments)}`;
    const count = (callGuard.get(key) || 0) + 1;
    callGuard.set(key, count);
    if (count > 4) {
      const content = `You have called ${call.name} with the same arguments ${count} times. Stop repeating it; try a different approach, inspect the result, or report what is blocking you.`;
      this.ui.toolEnd?.({ ok: false, summary: 'repeated call blocked', durationMs: Date.now() - started });
      return { content, isError: true };
    }

    let result;
    try {
      result = await tool.run(call.arguments, this.toolContext(signal));
    } catch (error) {
      result = {
        content: `Tool ${call.name} failed: ${error.message}${error.code === 'EACCES' ? ' (permission denied)' : ''}`,
        isError: true,
      };
    }
    const normalized = normalizeToolResult(result);
    this.ui.toolEnd?.({
      ok: !normalized.isError,
      summary: normalized.display?.summary || firstLine(normalized.content, 140),
      durationMs: Date.now() - started,
      display: normalized.display || null,
    });
    return normalized;
  }

  toolContext(signal) {
    return {
      cwd: this.cwd,
      config: this.config,
      session: this.session,
      signal,
      ui: this.ui,
      prompter: this.prompter,
      interactive: this.interactive,
      maxOutput: this.config.maxToolOutput || 60_000,
      ignoreRules: this.ignoreRules,
      askUser: this.askUser,
      shell: this.shell,
      approve: (request) => this.approvals.request(request),
      snapshot: (file, oldContent) => snapshotFile(this.session, file, oldContent),
      replacePluginTools: (pluginName, tools) => this.registry.replacePlugin(pluginName, tools),
      registry: this.registry,
    };
  }

  async save() {
    await saveSession(this.session);
  }
}

function ensureUniqueIds(toolCalls) {
  const seen = new Set();
  return toolCalls.map((call, index) => {
    let id = call.id || `call_${index}`;
    while (seen.has(id)) id = `${id}_${index}`;
    seen.add(id);
    return { ...call, id };
  });
}

function normalizeToolResult(result) {
  if (result == null) return { content: '(no output)' };
  if (typeof result === 'string') return { content: result };
  if (typeof result === 'object') {
    const content = result.content == null
      ? JSON.stringify(result, null, 2)
      : String(result.content);
    return {
      content,
      isError: Boolean(result.isError),
      display: result.display || null,
    };
  }
  return { content: String(result) };
}

function toolActionSummary(name, args) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];
  if (args.path) parts.push(String(args.path));
  if (args.command) parts.push(firstLine(args.command, 90));
  if (args.query) parts.push(`"${firstLine(args.query, 60)}"`);
  if (args.url) parts.push(firstLine(args.url, 80));
  if (args.repo) parts.push(args.action ? `${args.repo} · ${args.action}` : args.repo);
  if (args.name && !args.path) parts.push(String(args.name));
  if (parts.length === 0) {
    const json = JSON.stringify(args);
    if (json !== '{}') parts.push(truncateEnd(json, 90, 'arguments'));
  }
  return parts.join(' · ');
}

function formatTranscript(messages, maxChars) {
  const parts = [];
  for (const message of messages) {
    if (message.role === 'user') {
      parts.push(`USER:\n${truncateEnd(message.content, 12_000, 'message')}`);
    } else if (message.role === 'assistant') {
      const calls = (message.toolCalls || []).map((call) => `CALL ${call.name} ${JSON.stringify(call.arguments)}`).join('\n');
      parts.push(`ASSISTANT:\n${truncateEnd(message.content || '', 6000, 'message')}${calls ? `\n${truncateEnd(calls, 6000, 'tool calls')}` : ''}`);
    } else if (message.role === 'tool') {
      parts.push(`TOOL ${message.name}${message.isError ? ' (error)' : ''}:\n${truncateEnd(message.content, 3000, 'tool output')}`);
    }
  }
  return truncateEnd(parts.join('\n\n'), maxChars, 'transcript');
}

function isContextLengthError(error) {
  const text = `${error?.message || ''} ${error?.body || ''}`.toLowerCase();
  return /context length|context window|maximum context|too many tokens|prompt is too long|input.*too long|token limit/.test(text)
    || error?.status === 413;
}

function abortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}
