import { createFileTools } from './files.js';
import { createShellTool } from './shell.js';
import { createWebTools } from './web.js';
import { createTodoTools } from './todo.js';
import { createConnectionsTool } from './connections.js';
import { createPluginTool } from './plugins.js';
import { createGithubTools } from './github.js';

/** Mutable tool registry; plugin/MCP tools can be added during a session. */
export class ToolRegistry {
  constructor(tools = []) {
    this.tools = [];
    this.byName = new Map();
    this.addTools(tools);
  }

  addTools(tools) {
    for (const tool of tools) {
      if (!tool?.name || typeof tool.run !== 'function') continue;
      if (this.byName.has(tool.name)) continue;
      this.tools.push(tool);
      this.byName.set(tool.name, tool);
    }
    return this;
  }

  replacePlugin(pluginName, tools) {
    this.tools = this.tools.filter((tool) => tool.plugin !== pluginName);
    for (const [name, tool] of this.byName) {
      if (tool.plugin === pluginName) this.byName.delete(name);
    }
    this.addTools(tools);
  }

  get(name) {
    return this.byName.get(name) || null;
  }

  list() {
    return [...this.tools];
  }

  names() {
    return this.tools.map((tool) => tool.name);
  }

  schemas() {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || { type: 'object', properties: {} },
    }));
  }
}

export function createBuiltinTools({
  shell,
  config,
  githubConnection = null,
  pluginManager = null,
  mcpManager = null,
} = {}) {
  const tools = [
    ...createFileTools(),
    createShellTool(shell),
    ...createWebTools(),
    ...createTodoTools(),
  ];

  if (config?.plugins?.enabled !== false && pluginManager) {
    tools.push(createPluginTool({ pluginManager }));
  }
  if (githubConnection?.connected) {
    tools.push(...createGithubTools(githubConnection));
  }
  if (mcpManager) {
    tools.push(...mcpManager.getTools());
  }
  if (pluginManager) {
    tools.push(...pluginManager.tools);
  }
  tools.push(createConnectionsTool({ github: githubConnection, mcp: mcpManager, plugins: pluginManager }));
  return tools;
}
