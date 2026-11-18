import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fileSummary,
  formatIssues,
  formatRepos,
  githubAuth,
} from '../src/github.js';
import { createGithubTools } from '../src/tools/github.js';

const original = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GH_TOKEN: process.env.GH_TOKEN,
};

afterEach(() => {
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

test('githubAuth prefers GITHUB_TOKEN, then GH_TOKEN, then saved config', () => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  const config = { github: { token: 'config-token' } };
  assert.deepEqual(githubAuth(config), { token: 'config-token', source: 'config' });

  process.env.GH_TOKEN = 'gh-token';
  assert.deepEqual(githubAuth(config), { token: 'gh-token', source: 'GH_TOKEN' });

  process.env.GITHUB_TOKEN = 'github-token';
  assert.deepEqual(githubAuth(config), { token: 'github-token', source: 'GITHUB_TOKEN' });
});

test('githubAuth reports no connection when no token exists', () => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  const auth = githubAuth({ github: { token: '' } });
  assert.equal(auth.source, 'none');
  assert.equal(auth.token, '');
});

test('GitHub mutations request network approval so auto mode still asks', async () => {
  const seen = [];
  const tools = createGithubTools({
    connected: true,
    client: () => ({
      async createIssue() {
        throw new Error('createIssue should not run after denial');
      },
    }),
  });
  const issueTool = tools.find((tool) => tool.name === 'github_issues');
  const result = await issueTool.run(
    { repo: 'octocat/Hello-World', action: 'create', title: 'Test issue' },
    {
      approve: async (request) => {
        seen.push(request);
        return { allowed: false, reason: 'denied for test' };
      },
    },
  );

  assert.equal(result.isError, true);
  assert.equal(seen[0].category, 'network');
  assert.equal(seen[0].alwaysKey, 'github_write');
});

test('GitHub formatting helpers keep useful fields', () => {
  const repos = formatRepos([{
    full_name: 'octocat/Hello-World',
    description: 'My first repository',
    stargazers_count: 42,
    language: 'JavaScript',
    html_url: 'https://github.com/octocat/Hello-World',
    private: false,
  }]);
  assert.match(repos[0], /octocat\/Hello-World/);
  assert.match(repos[0], /42/);

  const issues = formatIssues([{
    number: 7,
    title: 'Bug report',
    state: 'open',
    user: { login: 'someone' },
    html_url: 'https://github.com/octocat/Hello-World/issues/7',
    pull_request: null,
  }]);
  assert.match(issues[0], /#7/);
  assert.match(issues[0], /Bug report/);

  const files = fileSummary([
    { type: 'file', path: 'index.js', size: 10 },
    { type: 'dir', path: 'src' },
  ]);
  assert.deepEqual(files, ['file  index.js (10 B)', 'dir   src']);
});
