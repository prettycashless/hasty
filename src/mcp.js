import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { isWindows, truncateEnd } from './util.js';

const PROTOCOL_VERSION = '2024-11-05';
const INIT_TIMEOUT = 20_000;
const CALL_TIMEOUT = 180_000;

class McpServerClient {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.status = 'disconnected';
    this.error = '';
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.tools = [];
    this.stderr = [];
    this.stdoutBuffer = '';
  }

  async start() {
    if (this.status === 'connected') return;
    if (!this.config?.command) {
      this.status = 'error';
      this.error = 'No command configured.';
      return;
    }
    if (this.config.disabled === true || this.config.enabled === false) {
      this.status = 'disabled';
      return;
    }
    this.status = 'starting';
    try {
      this.spawnProcess();
      await this.initialize();
      this.tools = await this.listTools();
      this.status = 'connected';
      this.error = '';
    } catch (error) {
      this.status = 'error';
      this.error = truncateEnd(error.message, 2000, 'error');
      this.stop();
    }
  }

  spawnProcess() {
    const command = String(this.config.command);
    const args = Array.isArray(this.config.args) ? this.config.args.map(String) : [];
    const env = { ...process.env, ...(this.config.env || {}) };
    const resolved = resolveExecutable(command);
    let child;
    if (isWindows && /\.(?:cmd|bat)$/i.test(resolved)) {
      const line = [quoteWin(resolved), ...args.map(quoteWin)].join(' ');
      child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
        cwd: this.config.cwd || process.cwd(),
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      child = spawn(resolved, args, {
        cwd: this.config.cwd || process.cwd(),
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderr.push(line.slice(0, 500));
        if (this.stderr.length > 25) this.stderr.shift();
      }
    });
    child.on('error', (error) => {
      this.failAll(new Error(`MCP server "${this.name}" failed to start: ${error.message}`));
      this.status = 'error';
      this.error = error.message;
    });
    child.on('exit', (code, signal) => {
      const detail = code != null ? `exit ${code}` : `signal ${signal}`;
      this.failAll(new Error(`MCP server "${this.name}" stopped (${detail}).${this.stderr.length ? `\n${this.stderr.slice(-5).join('\n')}` : ''}`));
      if (this.status !== 'disabled') {
        this.status = 'stopped';
        if (!this.error) this.error = detail;
      }
    });
  }

  onStdout(chunk) {
    this.stdoutBuffer += String(chunk);
    let newline;
    while ((newline = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // Servers sometimes print logs to stdout. Ignore non-JSON lines.
        continue;
      }
      this.onMessage(message);
    }
  }

  onMessage(message) {
    if (message.id == null) return; // notifications
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    } else {
      pending.resolve(message.result);
    }
  }

  request(method, params = {}, { timeout = INIT_TIMEOUT, signal = null } = {}) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error(`MCP server "${this.name}" is not running.`));
    }
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server "${this.name}" timed out on ${method}.`));
      }, timeout);
      timer.unref?.();
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.pending.set(id, {
        method,
        timer,
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new Error(`Could not write to MCP server "${this.name}": ${error.message}`));
        }
      });
    });
  }

  notify(method, params = {}) {
    if (!this.child?.stdin?.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {
      // The server is gone.
    }
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'hasty', version: '0.1.0' },
    }, { timeout: INIT_TIMEOUT });
    this.serverInfo = result?.serverInfo || null;
    this.notify('notifications/initialized');
  }

  async listTools() {
    const tools = [];
    let cursor = undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, {
        timeout: INIT_TIMEOUT,
      });
      tools.push(...(result?.tools || []));
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name, args, { signal = null, timeout = CALL_TIMEOUT } = {}) {
    if (this.status !== 'connected') {
      await this.start();
      if (this.status !== 'connected') {
        throw new Error(`MCP server "${this.name}" is unavailable: ${this.error || this.status}`);
      }
    }
    const result = await this.request('tools/call', { name, arguments: args || {} }, {
      timeout,
      signal,
    });
    const parts = [];
    for (const item of result?.content || []) {
      if (item.type === 'text') parts.push(item.text || '');
      else if (item.type === 'image') parts.push(`[image: ${item.mimeType || 'unknown'}]`);
      else if (item.type === 'resource') {
        if (item.resource?.text) parts.push(item.resource.text);
        else parts.push(`[resource: ${item.resource?.uri || 'unknown'}]`);
      } else {
        parts.push(JSON.stringify(item));
      }
    }
    if (result?.structuredContent) {
      parts.push(JSON.stringify(result.structuredContent, null, 2));
    }
    return {
      content: parts.join('\n') || '(MCP server returned no text content)',
      isError: Boolean(result?.isError),
    };
  }

  failAll(error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  stop() {
    this.failAll(new Error(`MCP server "${this.name}" was stopped.`));
    try {
      this.child?.stdin?.end();
      this.child?.kill();
    } catch {
      // Already gone.
    }
    this.child = null;
    if (this.status !== 'error') this.status = 'stopped';
  }

  info() {
    return {
      name: this.name,
      status: this.status,
      error: this.error,
      toolCount: this.tools.length,
      serverInfo: this.serverInfo,
    };
  }
}

export class McpManager {
  constructor({ config, ui = null } = {}) {
    this.config = config;
    this.ui = ui;
    this.clients = new Map();
    this.tools = [];
    const servers = config?.mcpServers && typeof config.mcpServers === 'object'
      ? Object.entries(config.mcpServers)
      : [];
    for (const [name, serverConfig] of servers) {
      if (!serverConfig || typeof serverConfig !== 'object') continue;
      this.clients.set(name, new McpServerClient(name, serverConfig));
    }
  }

  get configured() {
    return this.clients.size;
  }

  async connectAll() {
    if (this.clients.size === 0) return this;
    const results = await Promise.allSettled(
      [...this.clients.values()].map((client) => client.start()),
    );
    let index = 0;
    for (const client of this.clients.values()) {
      const result = results[index];
      index += 1;
      if (result.status === 'rejected') {
        client.status = 'error';
        client.error = result.reason?.message || String(result.reason);
      }
    }
    this.rebuildTools();
    for (const client of this.clients.values()) {
      if (client.status === 'error') {
        this.ui?.warn(`MCP ${client.name}: ${client.error}`);
      }
    }
    return this;
  }

  rebuildTools() {
    this.tools = [];
    const used = new Set();
    for (const client of this.clients.values()) {
      if (client.status !== 'connected') continue;
      for (const tool of client.tools) {
        let name = mcpToolName(client.name, tool.name);
        if (used.has(name)) {
          let suffix = 2;
          while (used.has(`${name}_${suffix}`)) suffix += 1;
          name = `${name}_${suffix}`;
        }
        used.add(name);
        const description = `[MCP ${client.name}] ${tool.description || tool.name}`;
        const definition = {
          name,
          mcpToolName: tool.name,
          mcpServer: client.name,
          permission: 'mcp',
          description: truncateEnd(description, 2000, 'description'),
          parameters: tool.inputSchema && typeof tool.inputSchema === 'object'
            ? tool.inputSchema
            : { type: 'object', properties: {} },
          autoApprove: Boolean(this.clients.get(client.name)?.config?.autoApprove),
          async run(args, ctx) {
            if (!definition.autoApprove) {
              const decision = await ctx.approve({
                category: 'mcp',
                tool: name,
                title: `mcp · ${client.name}`,
                detail: `Call "${tool.name}" on the MCP server "${client.name}". MCP tools can perform arbitrary actions.`,
                alwaysKey: `mcp:${client.name}`,
              });
              if (!decision.allowed) {
                return { content: `MCP call denied: ${decision.reason}.`, isError: true };
              }
            }
            try {
              const result = await client.callTool(tool.name, args, { signal: ctx.signal });
              return {
                ...result,
                display: {
                  summary: result.content.length > 120 ? `${result.content.length} chars` : result.content,
                  preview: result.isError ? truncateEnd(result.content, 2500, 'error') : '',
                  previewError: result.isError,
                },
              };
            } catch (error) {
              return { content: `MCP ${client.name}/${tool.name} failed: ${error.message}`, isError: true };
            }
          },
        };
        this.tools.push(definition);
      }
    }
  }

  getTools() {
    return this.tools;
  }

  serversInfo() {
    return [...this.clients.values()].map((client) => client.info());
  }

  closeAll() {
    for (const client of this.clients.values()) client.stop();
  }
}

function resolveExecutable(command) {
  if (!isWindows) return command;
  if (path.isAbsolute(command)) return command;
  const result = spawnSync('where', [command], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
  });
  if (result.status === 0) {
    const first = result.stdout.split(/\r?\n/).find(Boolean);
    if (first) return first.trim();
  }
  return command;
}

function quoteWin(value) {
  const text = String(value);
  if (!/[\s"&|<>^]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

export function mcpToolName(serverName, toolName) {
  const server = slug(serverName);
  const tool = slug(toolName);
  const prefix = `mcp__${server}__`;
  const max = 64;
  const available = Math.max(8, max - prefix.length);
  return `${prefix}${tool.slice(0, available)}`;
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'server';
}
