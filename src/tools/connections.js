import { githubToken, searchKeys } from '../config.js';

export function createConnectionsTool({ github = null, mcp = null, plugins = null } = {}) {
  return {
    name: 'list_connections',
    permission: 'read',
    description:
      'List configured connections and extension points: GitHub auth, web search keys, Hasty plugins with their tools, '
      + 'and MCP servers with connection status. Use this before telling the user a connection is unavailable.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async run(args, ctx) {
      const lines = [];
      const token = ctx.githubToken || githubToken(ctx.config);
      const login = github?.user?.login || github?.login;
      if (token) {
        lines.push(`GitHub: configured${login ? ` as ${login}` : ''}. Tools: github_search, github_repo, github_issues, github_pr, github_write_file, github_actions.`);
      } else {
        lines.push('GitHub: not configured. Run `hasty github login`, set GITHUB_TOKEN, or install/auth with the gh CLI.');
      }
      const keys = searchKeys(ctx.config);
      lines.push(`Web search: ${keys.brave ? 'Brave' : keys.tavily ? 'Tavily' : 'DuckDuckGo fallback (no API key)'}.`);
      lines.push(`Web fetch: enabled.`);

      if (plugins?.plugins?.length) {
        lines.push('', 'Plugins:');
        for (const plugin of plugins.plugins) {
          const names = plugin.tools.map((tool) => tool.name).join(', ');
          lines.push(`- ${plugin.name}: ${names || 'no tools'}`);
        }
      } else {
        lines.push('Plugins: none loaded. Use create_plugin to add a connection or capability.');
      }

      const mcpServers = mcp?.servers || mcp?.serversInfo?.() || [];
      if (mcpServers.length) {
        lines.push('', 'MCP servers:');
        for (const server of mcpServers) {
          lines.push(`- ${server.name}: ${server.status}${server.toolCount ? ` (${server.toolCount} tools)` : ''}${server.error ? ` — ${server.error}` : ''}`);
        }
      } else {
        lines.push('MCP servers: none configured. Add them under mcpServers in ~/.hasty/config.json.');
      }
      return { content: lines.join('\n') };
    },
  };
}
