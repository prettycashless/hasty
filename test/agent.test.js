import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent.js';
import { normalizeConfig } from '../src/config.js';
import { newSession } from '../src/session.js';
import { ToolRegistry } from '../src/tools/index.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hasty-agent-'));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hasty-agent-project-'));
process.env.HASTY_HOME = home;

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

function noopUI() {
  return new Proxy({}, { get: () => () => {} });
}

function makeAgent({ chat, tools = [], approvals = null, signal = null, config = {} }) {
  const session = newSession({ cwd, provider: 'fake', model: 'fake-1' });
  const registry = new ToolRegistry(tools);
  const provider = {
    runtime: { name: 'fake', label: 'Fake', model: 'fake-1' },
    chat,
  };
  const agent = new Agent({
    config: normalizeConfig({
      provider: 'fake',
      model: 'fake-1',
      maxSteps: 8,
      contextWindow: 128000,
      ...config,
    }),
    provider,
    session,
    cwd,
    registry,
    ui: noopUI(),
    approvals: approvals || { mode: 'yolo', request: async () => ({ allowed: true, reason: 'test' }) },
    shell: { label: 'bash', syntax: 'POSIX' },
    interactive: false,
  });
  return { agent, session, registry, signal };
}

test('agent executes a tool call and then returns the final answer', async () => {
  const calls = [];
  const toolCalls = [];
  const { agent, session } = makeAgent({
    tools: [{
      name: 'echo',
      description: 'Echo text',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      async run(args) {
        toolCalls.push(args.text);
        return { content: `echo:${args.text}` };
      },
    }],
    async chat({ messages, tools }) {
      calls.push({ messages: [...messages], tools });
      if (calls.length === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'call_1', name: 'echo', arguments: { text: 'hi' } }],
          usage: { input: 10, output: 5, total: 15 },
          finishReason: 'tool_calls',
        };
      }
      return {
        text: 'All done.',
        toolCalls: [],
        usage: { input: 4, output: 2, total: 6 },
        finishReason: 'stop',
      };
    },
  });

  const result = await agent.runTurn('do the thing');
  assert.equal(result.ok, true);
  assert.equal(result.text, 'All done.');
  assert.deepEqual(toolCalls, ['hi']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].tools.length, 1);
  assert.equal(calls[0].tools[0].name, 'echo');

  assert.deepEqual(
    session.messages.map((message) => message.role),
    ['user', 'assistant', 'tool', 'assistant'],
  );
  assert.equal(session.messages[2].content, 'echo:hi');
  assert.equal(session.messages[3].content, 'All done.');
  assert.equal(session.usage.total, 21);
});

test('agent reports provider failures without throwing', async () => {
  const { agent } = makeAgent({
    async chat() {
      throw new Error('boom');
    },
  });
  const result = await agent.runTurn('fail please');
  assert.equal(result.ok, false);
  assert.match(result.error.message, /boom/);
});

test('agent turns thrown tool errors into tool results', async () => {
  let calls = 0;
  const { agent, session } = makeAgent({
    tools: [{
      name: 'explode',
      description: 'Always fails',
      parameters: { type: 'object', properties: {} },
      async run() {
        throw new Error('kaboom');
      },
    }],
    async chat() {
      calls += 1;
      if (calls === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'call_1', name: 'explode', arguments: {} }],
          usage: null,
          finishReason: 'tool_calls',
        };
      }
      return { text: 'Recovered.', toolCalls: [], usage: null, finishReason: 'stop' };
    },
  });

  const result = await agent.runTurn('try it');
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Recovered.');
  const toolMessage = session.messages.find((message) => message.role === 'tool');
  assert.equal(toolMessage.isError, true);
  assert.match(toolMessage.content, /kaboom/);
});

test('agent respects a pre-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const { agent } = makeAgent({
    async chat() {
      called = true;
      return { text: 'should not get here', toolCalls: [] };
    },
  });
  const result = await agent.runTurn('stop now', { signal: controller.signal });
  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.error.aborted, true);
});

test('agent returns a visible note when it hits the step limit', async () => {
  const { agent } = makeAgent({
    config: { maxSteps: 2 },
    tools: [{
      name: 'echo',
      description: 'Echo text',
      parameters: { type: 'object', properties: {} },
      async run() {
        return { content: 'ok' };
      },
    }],
    async chat() {
      return {
        text: '',
        toolCalls: [{ id: 'call_1', name: 'echo', arguments: {} }],
        usage: null,
        finishReason: 'tool_calls',
      };
    },
  });

  const result = await agent.runTurn('keep going');
  assert.equal(result.ok, true);
  assert.match(result.text, /stopped after 2 tool steps/);
});

test('agent does not execute unknown tools', async () => {
  let calls = 0;
  const { agent, session } = makeAgent({
    async chat() {
      calls += 1;
      if (calls === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'call_1', name: 'missing_tool', arguments: {} }],
          usage: null,
        };
      }
      return { text: 'Okay.', toolCalls: [], usage: null };
    },
  });
  const result = await agent.runTurn('call a ghost');
  assert.equal(result.ok, true);
  const toolMessage = session.messages.find((message) => message.role === 'tool');
  assert.equal(toolMessage.isError, true);
  assert.match(toolMessage.content, /Unknown tool/);
});
