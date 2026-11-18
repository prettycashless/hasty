import fsp from 'node:fs/promises';
import path from 'node:path';
import { pluginsDir } from '../config.js';
import { truncateEnd } from '../util.js';

const PLUGIN_TEMPLATE_NOTE = `Plugin requirements:
- ES module with \`export default { name, description, tools: [...] }\`.
- Each tool: { name, description, parameters (JSON Schema), async run(args, ctx) }.
- Tool names are namespaced automatically as <plugin>_<tool>.
- Inside run(args, ctx), use global fetch, ctx.fs (fs/promises), ctx.path, ctx.env, ctx.cwd, ctx.config (keys redacted), ctx.signal.
- Return a string or { content, isError }. Keep output concise.
- Example:
  export default {
    name: "weather",
    description: "Weather lookups",
    tools: [{
      name: "forecast",
      description: "Get a forecast for a city",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      async run({ city }, ctx) {
        const res = await fetch("https://api.example.com/weather?q=" + encodeURIComponent(city), { signal: ctx.signal });
        return await res.text();
      }
    }]
  };`;

export function createPluginTool({ pluginManager }) {
  return {
    name: 'create_plugin',
    permission: 'execute',
    description:
      'Create a new local Hasty plugin (a custom tool/connection) when the user asks for a capability no built-in tool covers. '
      + 'Write a focused ES module, then Hasty saves it under ~/.hasty/plugins, reloads plugins, and returns the new tool names. '
      + 'The user must approve the code before it is written or run. Prefer built-in tools and MCP for existing services. '
      + PLUGIN_TEMPLATE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short plugin name (lowercase letters, digits, underscores).' },
        description: { type: 'string', description: 'What this plugin/connection does.' },
        code: { type: 'string', description: 'Complete ES module source code for the plugin.' },
        overwrite: { type: 'boolean', description: 'Overwrite an existing plugin file with the same name. Default false.' },
      },
      required: ['name', 'description', 'code'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const name = String(args.name || '').trim().toLowerCase();
      if (!/^[a-z][a-z0-9_]{1,47}$/.test(name)) {
        return {
          content: 'Plugin name must be 2-48 chars: lowercase letters, digits, underscores, starting with a letter.',
          isError: true,
        };
      }
      const code = String(args.code || '');
      if (!code.trim()) return { content: 'code is required.', isError: true };
      if (code.length > 150_000) return { content: 'Plugin code is too large (max 150k chars).', isError: true };
      if (!/export\s+default/.test(code)) {
        return { content: 'Plugin code must contain `export default`.', isError: true };
      }

      const dir = pluginsDir();
      const file = path.join(dir, `${name}.mjs`);
      let oldCode = null;
      try {
        oldCode = await fsp.readFile(file, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') {
          return { content: `Could not inspect existing plugin: ${error.message}`, isError: true };
        }
      }
      if (oldCode != null && !args.overwrite) {
        return {
          content: `Plugin "${name}" already exists at ${file}. Pass overwrite=true to replace it.`,
          isError: true,
        };
      }

      const decision = await ctx.approve({
        category: 'execute',
        tool: 'create_plugin',
        title: `create plugin · ${name}`,
        detail: `Write and load a JavaScript plugin at ${file}.\n\n${args.description || ''}`,
        preview: truncateEnd(code, 6000, 'plugin code'),
        danger: true,
        alwaysKey: `create_plugin:${name}`,
      });
      if (!decision.allowed) {
        return { content: `Plugin creation denied: ${decision.reason}.`, isError: true };
      }

      await fsp.mkdir(dir, { recursive: true });
      const previous = oldCode;
      try {
        await fsp.writeFile(file, code, 'utf8');
        await pluginManager.loadAll();
        const plugin = pluginManager.plugins.find((entry) => entry.file === file);
        if (!plugin) {
          const error = pluginManager.errors.find((entry) => entry.file === file);
          throw new Error(error?.message || 'Plugin did not load.');
        }
        const toolNames = plugin.tools.map((tool) => tool.name);
        ctx.replacePluginTools(plugin.name, plugin.tools);
        return {
          content: [
            `Plugin "${name}" saved to ${file}.`,
            `Loaded tools: ${toolNames.join(', ')}`,
            'Use the new tool(s) now. If it needs configuration or a key, ask the user for it.',
          ].join('\n'),
          display: { summary: `${toolNames.length} tool${toolNames.length === 1 ? '' : 's'} loaded` },
        };
      } catch (error) {
        // Roll back broken code so Hasty does not keep a non-loadable plugin.
        try {
          if (previous != null) await fsp.writeFile(file, previous, 'utf8');
          else await fsp.unlink(file);
        } catch {
          // Best effort.
        }
        await pluginManager.loadAll();
        return {
          content: `Plugin did not load: ${error.message}\nThe file was rolled back. Fix the code and retry.`,
          isError: true,
        };
      }
    },
  };
}
