import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpToolName, McpManager } from '../src/mcp.js';
import { normalizeConfig } from '../src/config.js';

test('mcpToolName produces stable, bounded names', () => {
  assert.equal(mcpToolName('filesystem', 'read_file'), 'mcp__filesystem__read_file');
  assert.equal(mcpToolName('My Server', 'Read File'), 'mcp__my_server__read_file');

  const long = mcpToolName('a'.repeat(80), 'b'.repeat(80));
  assert.ok(long.length <= 64);
  assert.match(long, /^mcp__a+__b+$/);
});

test('McpManager reports configured servers without starting them', () => {
  const config = normalizeConfig({
    mcpServers: {
      filesystem: { command: 'node', args: ['server.js'] },
      disabled: { command: 'node', disabled: true },
    },
  });
  const manager = new McpManager({ config });
  assert.equal(manager.configured, 2);
  assert.deepEqual(
    manager.serversInfo().map((server) => server.name).sort(),
    ['disabled', 'filesystem'],
  );
  assert.equal(manager.getTools().length, 0);
  manager.closeAll();
});

test('McpManager with no configured servers is inert', async () => {
  const manager = new McpManager({ config: normalizeConfig({}) });
  assert.equal(manager.configured, 0);
  await manager.connectAll();
  assert.deepEqual(manager.getTools(), []);
  manager.closeAll();
});
