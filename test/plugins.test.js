import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginManager } from '../src/plugins.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hasty-plugin-home-'));
process.env.HASTY_HOME = home;

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function pluginDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hasty-plugins-'));
}

function writePlugin(dir, name, source) {
  fs.writeFileSync(path.join(dir, name), source, 'utf8');
}

test('PluginManager loads a plugin and namespaces its tools', async () => {
  const dir = pluginDir();
  try {
    writePlugin(dir, 'demo.mjs', `
      export default {
        name: 'demo',
        description: 'Demo plugin',
        tools: [{
          name: 'hello',
          description: 'Say hello',
          parameters: { type: 'object', properties: { who: { type: 'string' } } },
          async run({ who }) { return 'hello ' + who; }
        }]
      };
    `);

    const manager = new PluginManager({ config: {}, dir });
    await manager.loadAll();

    assert.equal(manager.errors.length, 0);
    assert.equal(manager.plugins.length, 1);
    assert.equal(manager.plugins[0].name, 'demo');
    assert.equal(manager.tools.length, 1);
    assert.equal(manager.tools[0].name, 'demo_hello');

    const result = await manager.tools[0].run({ who: 'Cash' }, {
      cwd: dir,
      config: {},
      session: {},
      signal: null,
      ui: null,
      async approve() { return { allowed: true }; },
    });
    assert.equal(result.content, 'hello Cash');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reserved names cause plugin tools to be suffixed', async () => {
  const dir = pluginDir();
  try {
    writePlugin(dir, 'demo.mjs', `
      export default {
        name: 'demo',
        tools: [{
          name: 'hello',
          description: 'Say hello',
          parameters: { type: 'object', properties: {} },
          async run() { return 'second'; }
        }]
      };
    `);

    const manager = new PluginManager({
      config: {},
      dir,
      reservedNames: ['demo_hello'],
    });
    await manager.loadAll();
    assert.deepEqual(manager.tools.map((tool) => tool.name), ['demo_hello_2']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('broken plugins are reported without breaking the manager', async () => {
  const dir = pluginDir();
  try {
    fs.writeFileSync(path.join(dir, 'bad.mjs'), 'export default { name: "bad" };', 'utf8');
    const manager = new PluginManager({ config: {}, dir });
    await manager.loadAll();
    assert.equal(manager.plugins.length, 0);
    assert.equal(manager.errors.length, 1);
    assert.match(manager.errors[0].message, /at least one tool/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin tools require approval and honor denial', async () => {
  const dir = pluginDir();
  try {
    writePlugin(dir, 'guarded.mjs', `
      export default {
        name: 'guarded',
        tools: [{
          name: 'run',
          description: 'Guarded action',
          parameters: { type: 'object', properties: {} },
          async run() { return 'did it'; }
        }]
      };
    `);
    const manager = new PluginManager({ config: {}, dir });
    await manager.loadAll();
    const tool = manager.tools.find((entry) => entry.name === 'guarded_run');
    const denied = await tool.run({}, {
      cwd: dir,
      config: {},
      session: {},
      signal: null,
      ui: null,
      async approve() { return { allowed: false, reason: 'nope' }; },
    });
    assert.equal(denied.isError, true);
    assert.match(denied.content, /denied/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
