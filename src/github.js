import { spawnSync } from 'node:child_process';
import { githubToken } from './config.js';
import { maskSecret, truncateEnd } from './util.js';

export class GithubError extends Error {
  constructor(message, { status = 0, body = '' } = {}) {
    super(message);
    this.name = 'GithubError';
    this.status = status;
    this.body = body;
  }
}

let ghTokenCache = null;
let ghTokenCheckedAt = 0;

export function ghCliToken() {
  const now = Date.now();
  if (ghTokenCache != null && now - ghTokenCheckedAt < 60_000) return ghTokenCache;
  ghTokenCheckedAt = now;
  try {
    const result = spawnSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    ghTokenCache = result.status === 0 ? result.stdout.trim() : '';
  } catch {
    ghTokenCache = '';
  }
  return ghTokenCache;
}

export function githubAuth(config) {
  const explicit = githubToken(config);
  if (explicit) {
    return {
      token: explicit,
      source: process.env.GITHUB_TOKEN
        ? 'GITHUB_TOKEN'
        : process.env.GH_TOKEN
          ? 'GH_TOKEN'
          : 'config',
    };
  }
  const gh = ghCliToken();
  if (gh) return { token: gh, source: 'gh CLI' };
  return { token: '', source: 'none' };
}

export class GithubConnection {
  constructor(config) {
    this.config = config;
    this.auth = githubAuth(config);
    this.apiUrl = String(config.github?.apiUrl || 'https://api.github.com').replace(/\/+$/, '');
    this.user = null;
    this.lastError = null;
  }

  refresh() {
    this.auth = githubAuth(this.config);
    this.apiUrl = String(this.config.github?.apiUrl || 'https://api.github.com').replace(/\/+$/, '');
    this.user = null;
    this.lastError = null;
    return this.auth;
  }

  get connected() {
    return Boolean(this.auth.token);
  }

  get tokenPreview() {
    return this.auth.token ? maskSecret(this.auth.token) : '';
  }

  setToken(token, source = 'config') {
    this.config.github = { ...(this.config.github || {}), token: String(token || '').trim() };
    this.auth = { token: this.config.github.token, source };
    this.user = null;
    this.lastError = null;
    return this.auth;
  }

  client() {
    if (!this.auth.token) {
      throw new GithubError(
        'GitHub is not connected. Run `hasty github login`, set GITHUB_TOKEN/GH_TOKEN, or authenticate the gh CLI.',
      );
    }
    return new GithubClient({
      token: this.auth.token,
      apiUrl: this.apiUrl,
    });
  }

  async whoami(signal = null) {
    if (!this.connected) return null;
    try {
      const user = await this.client().getUser({ signal });
      this.user = user;
      this.lastError = null;
      return user;
    } catch (error) {
      this.lastError = error.message;
      return null;
    }
  }
}

export class GithubClient {
  constructor({ token, apiUrl = 'https://api.github.com' }) {
    this.token = token;
    this.apiUrl = String(apiUrl || 'https://api.github.com').replace(/\/+$/, '');
  }

  async request(path, {
    method = 'GET',
    body = null,
    accept = 'application/vnd.github+json',
    signal = null,
  } = {}) {
    const url = /^https?:\/\//.test(path) ? path : `${this.apiUrl}${path}`;
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          accept,
          authorization: `Bearer ${this.token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'hasty-cli',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: combineSignals(signal, AbortSignal.timeout(30_000)),
      });
    } catch (error) {
      throw new GithubError(`GitHub request failed: ${error.message}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const remaining = response.headers.get('x-ratelimit-remaining');
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      let message;
      if (response.status === 401) {
        message = 'GitHub rejected the token (401). Run `hasty github login` to reconnect.';
      } else if (response.status === 403 && remaining === '0') {
        const when = reset ? new Date(reset).toLocaleTimeString() : 'soon';
        message = `GitHub API rate limit reached. Resets at ${when}.`;
      } else if (response.status === 404) {
        message = `GitHub returned 404 for ${method} ${path}. Check the repository, path, number, or token permissions.`;
      } else if (response.status === 422) {
        message = `GitHub rejected the request (422). ${githubErrorMessage(text)}`;
      } else {
        message = `GitHub returned ${response.status}. ${githubErrorMessage(text)}`;
      }
      throw new GithubError(message, { status: response.status, body: text });
    }

    if (response.status === 204) return null;
    const type = response.headers.get('content-type') || '';
    if (type.includes('application/json')) return response.json();
    return response.text();
  }

  getUser({ signal } = {}) {
    return this.request('/user', { signal });
  }

  repo(repo, { signal } = {}) {
    return this.request(`/repos/${repoPath(repo)}`, { signal });
  }

  contents(repo, filePath = '', ref = null, { signal } = {}) {
    const encoded = filePath
      ? `/${filePath.split('/').map(encodeURIComponent).join('/')}`
      : '';
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    return this.request(`/repos/${repoPath(repo)}/contents${encoded}${query}`, { signal });
  }

  async readFile(repo, filePath, ref = null, { signal } = {}) {
    const data = await this.contents(repo, filePath, ref, { signal });
    if (Array.isArray(data)) throw new GithubError(`${filePath} is a directory; use action=tree.`);
    if (data.type !== 'file' || !data.content) {
      throw new GithubError(`GitHub did not return file content for ${filePath}.`);
    }
    return {
      sha: data.sha,
      path: data.path,
      size: data.size,
      content: Buffer.from(data.content, 'base64').toString('utf8'),
      htmlUrl: data.html_url,
      downloadUrl: data.download_url,
    };
  }

  async writeFile(repo, filePath, content, {
    message,
    branch = null,
    sha = null,
    signal = null,
  } = {}) {
    let existingSha = sha;
    if (!existingSha) {
      try {
        const existing = await this.contents(repo, filePath, branch, { signal });
        if (existing && !Array.isArray(existing)) existingSha = existing.sha;
      } catch (error) {
        if (!(error instanceof GithubError) || error.status !== 404) throw error;
      }
    }
    const data = await this.request(
      `/repos/${repoPath(repo)}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`,
      {
        method: 'PUT',
        body: {
          message: message || `Update ${filePath}`,
          content: Buffer.from(content, 'utf8').toString('base64'),
          ...(existingSha ? { sha: existingSha } : {}),
          ...(branch ? { branch } : {}),
        },
        signal,
      },
    );
    return {
      commitSha: data.commit?.sha,
      commitUrl: data.commit?.html_url,
      htmlUrl: data.content?.html_url,
      created: !existingSha,
    };
  }

  async deleteFile(repo, filePath, { message, branch = null, signal = null } = {}) {
    const existing = await this.contents(repo, filePath, branch, { signal });
    if (!existing || Array.isArray(existing)) {
      throw new GithubError(`${filePath} is not a file or does not exist.`);
    }
    const data = await this.request(
      `/repos/${repoPath(repo)}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`,
      {
        method: 'DELETE',
        body: {
          message: message || `Delete ${filePath}`,
          sha: existing.sha,
          ...(branch ? { branch } : {}),
        },
        signal,
      },
    );
    return { commitSha: data.commit?.sha, commitUrl: data.commit?.html_url };
  }

  search(kind, query, { limit = 10, signal = null } = {}) {
    const path = kind === 'code'
      ? '/search/code'
      : kind === 'repos'
        ? '/search/repositories'
        : '/search/issues';
    return this.request(`${path}?q=${encodeURIComponent(query)}&per_page=${Math.min(30, limit)}`, {
      accept: kind === 'code'
        ? 'application/vnd.github.text-match+json'
        : 'application/vnd.github+json',
      signal,
    });
  }

  branches(repo, { limit = 30, signal = null } = {}) {
    return this.request(`/repos/${repoPath(repo)}/branches?per_page=${Math.min(100, limit)}`, { signal });
  }

  commits(repo, { limit = 10, signal = null } = {}) {
    return this.request(`/repos/${repoPath(repo)}/commits?per_page=${Math.min(100, limit)}`, { signal });
  }

  issues(repo, { state = 'open', limit = 15, signal = null } = {}) {
    return this.request(`/repos/${repoPath(repo)}/issues?state=${encodeURIComponent(state)}&per_page=${Math.min(100, limit)}`, { signal });
  }

  issue(repo, number, { signal = null } = {}) {
    return this.request(`/repos/${repoPath(repo)}/issues/${number}`, { signal });
  }

  createIssue(repo, { title, body, labels = [], signal = null }) {
    return this.request(`/repos/${repoPath(repo)}/issues`, {
      method: 'POST',
      body: { title, body, labels },
      signal,
    });
  }

  addComment(repo, number, body, { signal = null } = {}) {
    return this.request(`/repos/${repoPath(repo)}/issues/${number}/comments`, {
      method: 'POST',
      body: { body },
      signal,
    });
  }

  patchIssue(repo, number, patch, { signal = null } = {}) {
    return this.request(`/repos/${repoPath(repo)}/issues/${number}`, {
      method: 'PATCH',
      body: patch,
      signal,
    });
  }

  pulls(repo, { state = 'open', limit = 15, signal = null } = {}) {
    return this.request(`/repos/${repoPath(repo)}/pulls?state=${encodeURIComponent(state)}&per_page=${Math.min(100, limit)}`, { signal });
  }

  pull(repo, number, { signal = null } = {}) {
    return this.request(`/repos/${repoPath(repo)}/pulls/${number}`, { signal });
  }

  pullFiles(repo, number, { signal = null } = {}) {
    return this.request(`/repos/${repoPath(repo)}/pulls/${number}/files?per_page=100`, { signal });
  }

  createPull(repo, { title, head, base, body, draft = false, signal = null }) {
    return this.request(`/repos/${repoPath(repo)}/pulls`, {
      method: 'POST',
      body: { title, head, base, body, draft },
      signal,
    });
  }

  reviewPull(repo, number, { event, body, signal = null }) {
    return this.request(`/repos/${repoPath(repo)}/pulls/${number}/reviews`, {
      method: 'POST',
      body: { event, body },
      signal,
    });
  }

  mergePull(repo, number, { method = 'merge', title = null, signal = null } = {}) {
    return this.request(`/repos/${repoPath(repo)}/pulls/${number}/merge`, {
      method: 'PUT',
      body: {
        merge_method: method,
        ...(title ? { commit_title: title } : {}),
      },
      signal,
    });
  }

  patchPull(repo, number, patch, { signal = null } = {}) {
    return this.request(`/repos/${repoPath(repo)}/pulls/${number}`, {
      method: 'PATCH',
      body: patch,
      signal,
    });
  }

  workflowRuns(repo, { limit = 10, branch = null, signal = null } = {}) {
    const query = new URLSearchParams({ per_page: String(Math.min(50, limit)) });
    if (branch) query.set('branch', branch);
    return this.request(`/repos/${repoPath(repo)}/actions/runs?${query}`, { signal });
  }

  rerunWorkflow(repo, runId, { signal = null } = {}) {
    return this.request(`/repos/${repoPath(repo)}/actions/runs/${runId}/rerun`, {
      method: 'POST',
      body: {},
      signal,
    });
  }
}

function repoPath(repo) {
  const value = String(repo || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new GithubError(`Invalid repo "${repo}". Use owner/name, e.g. octocat/Hello-World.`);
  }
  return value;
}

function githubErrorMessage(text) {
  try {
    const json = JSON.parse(text);
    const details = Array.isArray(json.errors)
      ? json.errors.map((entry) => entry.message || JSON.stringify(entry)).join('; ')
      : '';
    return [json.message, details].filter(Boolean).join(' — ') || truncateEnd(text, 400, 'error');
  } catch {
    return truncateEnd(String(text || ''), 400, 'error');
  }
}

function combineSignals(a, b) {
  if (!a) return b;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

export function formatRepos(items) {
  return items.map((item) => [
    `${item.full_name}${item.private ? ' (private)' : ''}${item.archived ? ' [archived]' : ''}`,
    `  ${item.description || 'No description'} · ★ ${item.stargazers_count} · ${item.html_url}`,
  ].join('\n'));
}

export function formatIssues(items) {
  return items.map((item) => {
    const labels = (item.labels || []).map((label) => (typeof label === 'string' ? label : label.name)).filter(Boolean);
    const kind = item.pull_request ? 'PR' : 'issue';
    return `#${item.number} [${kind}/${item.state}] ${item.title}`
      + `${labels.length ? ` · ${labels.join(', ')}` : ''}`
      + `${item.user?.login ? ` · @${item.user.login}` : ''}`
      + `\n  ${item.html_url}`;
  });
}

export function fileSummary(items) {
  return items.map((item) => `${item.type === 'dir' ? 'dir ' : 'file'}  ${item.path}${item.type === 'file' ? ` (${item.size} B)` : ''}`);
}

export { repoPath };
