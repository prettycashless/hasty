import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { pluginsDir, redactedConfig } from './config.js';
import { truncateEnd } from './util.js';

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Loads user plugins from ~/.hasty/plugins.
 * Plugins are trusted local ES modules; creating one requires approval.
 */
export class PluginManager {
  constructor({ config, dir = null, ui = null, reservedNames = [] } = {}) {
    this.config = config;
    this.dir = dir || pluginsDir();
    this.ui = ui;
    this.reservedNames = new Set(reservedNames);
    this.plugins = [];
    this.tools = [];
    this.errors = [];
  }

  async loadAll() {
    this.plugins = [];
    this.tools = [];
    this.errors = [];
    let entries;
    try {
      entries = await fsp.readdir(this.dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return this;
      this.errors.push({ file: this.dir, message: error.message });
      return this;
    }
    const files = entries
      .filter((entry) => entry.isFile() && /\.(?:mjs|js)$/i.test(entry.name))
      .map((entry) => path.join(this.dir, entry.name))
      .sort();

    for (const file of files) {
      try {
        const plugin = await this.loadFile(file);
        if (!plugin) continue;
        const names = new Set([...this.reservedNames, ...this.tools.map((tool) => tool.name)]);
        for (const tool of plugin.tools) {
          let name = tool.name;
          if (names.has(name)) {
            let suffix = 2;
            while (names.has(`${name}_${suffix}`)) suffix += 1;
            name = `${name}_${suffix}`;
            tool.name = name;
          }
          names.add(name);
        }
        this.plugins.push(plugin);
        this.tools.push(...plugin.tools);
      } catch (error) {
        this.errors.push({ file, message: error.message });
        this.ui?.warn(`Plugin failed to load: ${path.basename(file)} — ${firstLine(error.message)}`);
      }
    }
    return this;
  }

  async loadFile(file) {
    const stat = await fsp.stat(file);
    const url = `${pathToFileURL(file).href}?v=${stat.mtimeMs}`;
    const module = await import(url);
    let definition = module.default ?? module.plugin;
    if (typeof definition === 'function') {
      definition = await definition({ env: process.env });
    }
    if (!definition || typeof definition !== 'object') {
      throw new Error('Plugin must export an object as default.');
    }
    const baseName = slug(definition.name || path.basename(file, path.extname(file)));
    const description = String(definition.description || '').slice(0, 500);
    let rawTools = definition.tools;
    if (rawTools && !Array.isArray(rawTools)) {
      rawTools = Object.entries(rawTools).map(([name, value]) => ({ ...value, name }));
    }
    if (!Array.isArray(rawTools) || rawTools.length === 0) {
      throw new Error('Plugin must expose at least one tool in `tools`.');
    }

    const tools = [];
    for (const raw of rawTools) {
      if (!raw || typeof raw !== 'object') throw new Error('Invalid tool definition.');
      const bareName = slug(raw.name || '');
      if (!bareName) throw new Error('Every plugin tool needs a name.');
      const finalName = bareName.startsWith(`${baseName}_`) ? bareName : `${baseName}_${bareName}`;
      if (!TOOL_NAME_RE.test(finalName)) {
        throw new Error(`Invalid tool name "${finalName}" (use lowercase letters, digits, underscores; max 64 chars).`);
      }
      if (typeof raw.run !== 'function') {
        throw new Error(`Plugin tool "${finalName}" is missing a run(args, ctx) function.`);
      }
      if (!raw.parameters || typeof raw.parameters !== 'object') {
        throw new Error(`Plugin tool "${finalName}" is missing a JSON-schema parameters object.`);
      }
      const descriptionText = truncateEnd(
        `[plugin:${baseName}] ${String(raw.description || '').trim() || 'Custom plugin tool.'}`,
        2000,
        'description',
      );
      tools.push({
        name: finalName,
        originalName: raw.name || bareName,
        plugin: baseName,
        description: descriptionText,
        parameters: raw.parameters,
        permission: 'execute',
        pluginFile: file,
        async run(args, ctx) {
          const decision = await ctx.approve({
            category: 'execute',
            tool: finalName,
            title: `plugin · ${finalName}`,
            detail: `Run the user-installed plugin "${baseName}" from ${file}.`,
            alwaysKey: `plugin:${baseName}`,
          });
          if (!decision.allowed) {
            return {
              content: `Plugin call denied: ${decision.reason}.`,
              isError: true,
            };
          }
          try {
            const result = await raw.run(args || {}, {
              fetch,
              fs: fsp,
              fsp,
              path,
              os,
              cwd: ctx.cwd,
              workspace: ctx.cwd,
              config: redactedConfig(ctx.config || {}),
              env: process.env,
              signal: ctx.signal,
              session: ctx.session,
              approve: ctx.approve,
              log: (...values) => {
                if (ctx.ui?.info) ctx.ui.info(`[${baseName}] ${values.join(' ')}`);
              },
            });
            return normalizePluginResult(result);
          } catch (error) {
            return {
              content: `Plugin ${finalName} failed: ${error.message}\n${firstLine(error.stack || '', 1200)}`,
              isError: true,
            };
          }
        },
      });
    }

    return {
      name: baseName,
      description,
      file,
      tools,
    };
  }

  summary() {
    return {
      plugins: this.plugins.map((plugin) => ({
        name: plugin.name,
        description: plugin.description,
        file: plugin.file,
        tools: plugin.tools.map((tool) => ({ name: tool.name, description: tool.description })),
      })),
      errors: this.errors,
    };
  }
}

function normalizePluginResult(result) {
  if (typeof result === 'string') return { content: result };
  if (result == null) return { content: '(plugin returned no output)' };
  if (typeof result === 'object') {
    if (typeof result.content === 'string') return result;
    return { content: JSON.stringify(result, null, 2) };
  }
  return { content: String(result) };
}

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function firstLine(text, max = 300) {
  const line = String(text || '').split('\n')[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
