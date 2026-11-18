import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const bin = path.join(root, 'bin', 'hasty.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hasty-e2e-home-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hasty-e2e-project-'));
const requests = [];
let server;

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function startServer() {
  server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      const sawToolResult = body.messages.some((message) => message.role === 'tool');
      if (!sawToolResult) {
        sse(res, {
          choices: [{
            delta: {
              role: 'assistant',
              tool_calls: [{
                index: 0,
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({ path: 'created.txt', content: 'from mock\n' }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        });
        sse(res, {
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        });
      } else {
        sse(res, {
          choices: [{ delta: { content: 'Wrote the file.' }, finish_reason: null }],
        });
        sse(res, {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
        });
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/v1`));
  });
}

function run(args, env, input = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: root,
      env,
      stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    if (input != null) child.stdin.end(input);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

test('print mode streams a tool call, executes it, and prints the final answer', async () => {
  fs.rmSync(path.join(project, 'created.txt'), { force: true });
  requests.length = 0;
  const base = await startServer();
  const result = await run(['--yes', '--no-mcp', '--no-plugins', '--cwd', project, '-p', 'make a file'], {
    ...process.env,
    HASTY_HOME: home,
    HASTY_PROVIDER: 'custom',
    HASTY_BASE_URL: base,
    HASTY_API_KEY: 'test-key',
    HASTY_MODEL: 'mock-model',
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
  });
  await new Promise((resolve) => server.close(resolve));
  server = null;

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Wrote the file\./);
  assert.equal(fs.readFileSync(path.join(project, 'created.txt'), 'utf8'), 'from mock\n');
  assert.equal(requests.length, 2);
  assert.ok(requests[0].tools.some((tool) => tool.function.name === 'write_file'));
  assert.equal(requests[0].model, 'mock-model');
  assert.equal(requests[0].stream, true);
});

test('resume loads the saved session and treats the id as an id, not a prompt', async () => {
  const sessions = path.join(home, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'resume-test.json'), JSON.stringify({
    schema: 1,
    id: 'resume-test',
    title: 'Earlier work',
    cwd: project,
    provider: 'custom',
    model: 'mock-model',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [
      { role: 'user', content: 'previous question' },
      { role: 'assistant', content: 'previous answer' },
    ],
    todos: [],
    usage: { input: 0, output: 0, total: 0 },
    backups: [],
    compactions: 0,
  }));

  fs.rmSync(path.join(project, 'created.txt'), { force: true });
  requests.length = 0;
  const base = await startServer();
  const result = await run([
    'resume', 'resume-test', '--yes', '--no-mcp', '--no-plugins',
    '--cwd', project, '-p', 'next question',
  ], {
    ...process.env,
    HASTY_HOME: home,
    HASTY_PROVIDER: 'custom',
    HASTY_BASE_URL: base,
    HASTY_API_KEY: 'test-key',
    HASTY_MODEL: 'mock-model',
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
  });
  await new Promise((resolve) => server.close(resolve));
  server = null;

  assert.equal(result.status, 0, result.stderr);
  const messages = requests[0].messages;
  assert.ok(messages.some((message) => message.content === 'previous question'));
  assert.ok(messages.some((message) => message.content === 'previous answer'));
  assert.equal(messages[messages.length - 1].content, 'next question');
  assert.ok(!messages.some((message) => message.role === 'user' && message.content === 'resume-test'));
});

test('piped stdin is attached as context when a prompt is also provided', async () => {
  fs.rmSync(path.join(project, 'created.txt'), { force: true });
  requests.length = 0;
  const base = await startServer();
  const result = await run([
    '--yes', '--no-mcp', '--no-plugins', '--cwd', project, '-p', 'review this log',
  ], {
    ...process.env,
    HASTY_HOME: home,
    HASTY_PROVIDER: 'custom',
    HASTY_BASE_URL: base,
    HASTY_API_KEY: 'test-key',
    HASTY_MODEL: 'mock-model',
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
  }, 'line one\nline two\n');
  await new Promise((resolve) => server.close(resolve));
  server = null;

  assert.equal(result.status, 0, result.stderr);
  const prompt = requests[0].messages.find((message) => message.role === 'user').content;
  assert.match(prompt, /review this log/);
  assert.match(prompt, /<stdin>\nline one\nline two\n<\/stdin>/);
});

test('@file attachments work in one-shot prompts', async () => {
  fs.writeFileSync(path.join(project, 'input.txt'), 'alpha\nbeta\n');
  fs.rmSync(path.join(project, 'created.txt'), { force: true });
  requests.length = 0;
  const base = await startServer();
  const result = await run([
    '--yes', '--no-mcp', '--no-plugins', '--cwd', project, '-p', 'summarize @input.txt',
  ], {
    ...process.env,
    HASTY_HOME: home,
    HASTY_PROVIDER: 'custom',
    HASTY_BASE_URL: base,
    HASTY_API_KEY: 'test-key',
    HASTY_MODEL: 'mock-model',
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
  });
  await new Promise((resolve) => server.close(resolve));
  server = null;

  assert.equal(result.status, 0, result.stderr);
  const prompt = requests[0].messages.find((message) => message.role === 'user').content;
  assert.match(prompt, /summarize @input\.txt/);
  assert.match(prompt, /<attached_files>/);
  assert.match(prompt, /<file path="input\.txt">/);
  assert.match(prompt, /alpha\nbeta/);
});

test('--json emits JSONL events for the turn', async () => {
  fs.rmSync(path.join(project, 'created.txt'), { force: true });
  requests.length = 0;
  const base = await startServer();
  const result = await run(['--yes', '--no-mcp', '--no-plugins', '--json', '--cwd', project, '-p', 'make a file'], {
    ...process.env,
    HASTY_HOME: home,
    HASTY_PROVIDER: 'custom',
    HASTY_BASE_URL: base,
    HASTY_API_KEY: 'test-key',
    HASTY_MODEL: 'mock-model',
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
  });
  await new Promise((resolve) => server.close(resolve));
  server = null;

  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const types = events.map((event) => event.type);
  assert.ok(types.includes('turn_start'));
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('tool_result'));
  assert.ok(types.includes('turn_end'));
  assert.ok(types.includes('result'));
  assert.equal(events.find((event) => event.type === 'result').ok, true);
  assert.match(result.stdout, /Wrote the file\./);
});
