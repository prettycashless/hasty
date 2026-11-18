import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createOpenAIProvider, toOpenAIMessages } from '../src/providers/openai.js';
import { toAnthropicMessages } from '../src/providers/anthropic.js';
import { normalizeUsage } from '../src/providers/http.js';

let server;
let baseUrl;

before(async () => {
  server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;

    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] }));
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      const payload = JSON.parse(body || '{}');
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);

      if (payload.model === 'tool-model') {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_', arguments: '{"city":' } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'weather', arguments: '"Paris"}' } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ choices: [{ delta: { content: 'Hello ' } }] });
        send({ choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }] });
        send({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
      }
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'not found' } }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

function runtime(model = 'test-model') {
  return {
    name: 'test',
    label: 'Test Provider',
    type: 'openai',
    baseUrl,
    apiKey: 'test-key',
    model,
    maxTokens: 100,
    temperature: 0,
    keyless: false,
  };
}

test('OpenAI-compatible provider streams text and usage', async () => {
  const provider = createOpenAIProvider(runtime());
  const chunks = [];
  const result = await provider.chat({
    system: 'be brief',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    onText: (chunk) => chunks.push(chunk),
  });
  assert.equal(result.text, 'Hello world');
  assert.deepEqual(chunks, ['Hello ', 'world']);
  assert.deepEqual(result.usage, { input: 3, output: 2, total: 5 });
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.model, 'test-model');
});

test('OpenAI-compatible provider assembles streamed tool calls', async () => {
  const provider = createOpenAIProvider(runtime('tool-model'));
  const result = await provider.chat({
    system: '',
    messages: [{ role: 'user', content: 'weather?' }],
    tools: [],
  });
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, 'call_1');
  assert.equal(result.toolCalls[0].name, 'get_weather');
  assert.deepEqual(result.toolCalls[0].arguments, { city: 'Paris' });
  assert.equal(result.toolCalls[0].parseError, null);
  assert.equal(result.finishReason, 'tool_calls');
});

test('listModels fetches and sorts model ids', async () => {
  const provider = createOpenAIProvider(runtime());
  const models = await provider.listModels();
  assert.deepEqual(models, ['model-a', 'model-b']);
});

test('OpenAI message conversion preserves tool calls and results', () => {
  const messages = toOpenAIMessages('system', [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.js' } }] },
    { role: 'tool', toolCallId: 'c1', content: 'contents' },
  ]);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].content, 'hello');
  assert.equal(messages[2].tool_calls[0].function.name, 'read_file');
  assert.equal(messages[2].tool_calls[0].function.arguments, '{"path":"a.js"}');
  assert.equal(messages[3].role, 'tool');
  assert.equal(messages[3].tool_call_id, 'c1');
});

test('Anthropic message conversion merges consecutive user turns', () => {
  const messages = toAnthropicMessages([
    { role: 'user', content: 'one' },
    { role: 'user', content: 'two' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.js' } }] },
    { role: 'tool', toolCallId: 'c1', content: 'result' },
  ]);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content.length, 2);
  assert.equal(messages[1].content[0].type, 'tool_use');
  assert.equal(messages[2].content[0].type, 'tool_result');
});

test('normalizeUsage understands both usage shapes', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 1, completion_tokens: 2 }), {
    input: 1,
    output: 2,
    total: 3,
  });
  assert.deepEqual(normalizeUsage({ input_tokens: 5, output_tokens: 6, total_tokens: 11 }), {
    input: 5,
    output: 6,
    total: 11,
  });
  assert.equal(normalizeUsage(null), null);
});
