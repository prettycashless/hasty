import { diffLines } from '../diff.js';
import {
  GithubError,
  fileSummary,
  formatIssues,
  formatRepos,
} from '../github.js';
import { firstLine, truncateEnd } from '../util.js';

const REPO_PROP = {
  type: 'string',
  description: 'Repository in owner/name form, e.g. "octocat/Hello-World".',
};

export function createGithubTools(connection) {
  if (!connection) return [];
  return [
    {
      name: 'github_search',
      permission: 'read',
      description:
        'Search GitHub repositories, code, or issues/PRs. Requires a connected GitHub token. '
        + 'Code search needs a token with repository access.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'GitHub search query. Qualifiers like repo:, org:, is:pr work.' },
          type: { type: 'string', enum: ['code', 'repos', 'issues'], description: 'What to search. Default repos.' },
          limit: { type: 'integer', description: 'Results (1-30). Default 10.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async run(args, ctx) {
        try {
          const client = requireClient(connection);
          const kind = ['code', 'repos', 'issues'].includes(args.type) ? args.type : 'repos';
          const limit = Math.min(30, Math.max(1, Number(args.limit) || 10));
          const result = await client.search(kind, String(args.query || ''), { limit, signal: ctx.signal });
          const items = result.items || [];
          if (items.length === 0) return { content: `No ${kind} results for "${args.query}".` };
          let body;
          if (kind === 'repos') body = formatRepos(items).join('\n\n');
          else if (kind === 'issues') body = formatIssues(items).join('\n');
          else {
            body = items.map((item) => {
              const fragments = (item.text_matches || [])
                .map((match) => (match.fragment || '').replace(/\s+/g, ' ').trim())
                .filter(Boolean)
                .slice(0, 2);
              return `${item.repository?.full_name || ''}/${item.path}`
                + `${fragments.length ? `\n  ${fragments.join('\n  ')}` : ''}`
                + `\n  ${item.html_url}`;
            }).join('\n\n');
          }
          return {
            content: `${result.total_count || items.length} ${kind} results for "${args.query}" (showing ${items.length}):\n\n${body}`,
            display: { summary: `${items.length} results` },
          };
        } catch (error) {
          return githubFailure(error);
        }
      },
    },
    {
      name: 'github_repo',
      permission: 'read',
      description:
        'Inspect a GitHub repository: metadata, directory tree, file contents, branches, or recent commits. '
        + 'Reads are auto-approved once GitHub is connected.',
      parameters: {
        type: 'object',
        properties: {
          repo: REPO_PROP,
          action: {
            type: 'string',
            enum: ['info', 'tree', 'read', 'branches', 'commits'],
            description: 'Operation to perform. Default info.',
          },
          path: { type: 'string', description: 'File or directory path for tree/read. Root if omitted.' },
          ref: { type: 'string', description: 'Branch, tag, or commit SHA for tree/read.' },
          limit: { type: 'integer', description: 'For branches/commits: number of entries (default 20).' },
        },
        required: ['repo'],
        additionalProperties: false,
      },
      async run(args, ctx) {
        try {
          const client = requireClient(connection);
          const repo = String(args.repo || '');
          const action = args.action || 'info';
          if (action === 'info') {
            const data = await client.repo(repo, { signal: ctx.signal });
            return {
              content: [
                `${data.full_name}${data.private ? ' (private)' : ''}`,
                `URL: ${data.html_url}`,
                `Description: ${data.description || '(none)'}`,
                `Default branch: ${data.default_branch}`,
                `Language: ${data.language || 'unknown'} · ★ ${data.stargazers_count} · forks ${data.forks_count} · open issues ${data.open_issues_count}`,
                `Permissions: ${Object.entries(data.permissions || {}).filter(([, value]) => value).map(([key]) => key).join(', ') || 'read'}`,
                data.updated_at ? `Updated: ${data.updated_at}` : '',
              ].filter(Boolean).join('\n'),
            };
          }
          if (action === 'tree') {
            const data = await client.contents(repo, args.path || '', args.ref || null, { signal: ctx.signal });
            if (Array.isArray(data)) {
              return { content: `${repo}/${args.path || ''}\n${fileSummary(data).join('\n')}` };
            }
            return { content: `${data.path} is a file (${data.size} B). Use action=read.` };
          }
          if (action === 'read') {
            if (!args.path) return { content: 'path is required for action=read.', isError: true };
            const file = await client.readFile(repo, args.path, args.ref || null, { signal: ctx.signal });
            const body = truncateEnd(file.content, 80_000, 'file');
            return {
              content: `${repo}/${file.path} (sha ${file.sha}, ${file.size} B)\n${body}`,
              display: { summary: `${file.size} B · ${file.sha.slice(0, 7)}` },
            };
          }
          if (action === 'branches') {
            const items = await client.branches(repo, { limit: Number(args.limit) || 20, signal: ctx.signal });
            return { content: items.map((item) => `${item.name}  ${item.commit?.sha?.slice(0, 7) || ''}`).join('\n') || 'No branches.' };
          }
          if (action === 'commits') {
            const items = await client.commits(repo, { limit: Number(args.limit) || 10, signal: ctx.signal });
            return {
              content: items.map((item) => `${item.sha.slice(0, 7)}  ${firstLine(item.commit?.message || '', 100)}  — ${item.commit?.author?.name || ''} ${item.commit?.author?.date || ''}`).join('\n') || 'No commits.',
            };
          }
          return { content: `Unknown action: ${action}`, isError: true };
        } catch (error) {
          return githubFailure(error);
        }
      },
    },
    {
      name: 'github_issues',
      permission: 'read',
      description:
        'List, read, create, comment on, close, or reopen GitHub issues. Mutations require approval.',
      parameters: {
        type: 'object',
        properties: {
          repo: REPO_PROP,
          action: {
            type: 'string',
            enum: ['list', 'get', 'create', 'comment', 'close', 'reopen'],
            description: 'Operation. Default list.',
          },
          number: { type: 'integer', description: 'Issue number for get/comment/close/reopen.' },
          title: { type: 'string', description: 'Title for create.' },
          body: { type: 'string', description: 'Body for create/comment.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Labels for create.' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'State filter for list. Default open.' },
          limit: { type: 'integer', description: 'List size (default 15).' },
        },
        required: ['repo'],
        additionalProperties: false,
      },
      async run(args, ctx) {
        try {
          const client = requireClient(connection);
          const repo = String(args.repo || '');
          const action = args.action || 'list';
          if (action === 'list') {
            const items = await client.issues(repo, {
              state: args.state || 'open',
              limit: Number(args.limit) || 15,
              signal: ctx.signal,
            });
            return { content: items.length ? formatIssues(items).join('\n') : 'No issues.' };
          }
          if (action === 'get') {
            requireNumber(args.number);
            const item = await client.issue(repo, args.number, { signal: ctx.signal });
            return {
              content: [
                `#${item.number} ${item.title} [${item.state}]`,
                `Author: @${item.user?.login || '?'} · comments: ${item.comments} · labels: ${(item.labels || []).map((label) => label.name).join(', ') || 'none'}`,
                `URL: ${item.html_url}`,
                '',
                truncateEnd(item.body || '(no body)', 20_000, 'issue body'),
              ].join('\n'),
            };
          }
          if (action === 'create') {
            if (!args.title) return { content: 'title is required for create.', isError: true };
            const ok = await approveMutation(ctx, {
              title: `create issue · ${repo}`,
              detail: args.title,
              preview: truncateEnd(args.body || '', 3000, 'issue body'),
            });
            if (!ok) return denied('Issue creation');
            const item = await client.createIssue(repo, {
              title: args.title,
              body: args.body || '',
              labels: Array.isArray(args.labels) ? args.labels : [],
              signal: ctx.signal,
            });
            return { content: `Created issue #${item.number}: ${item.title}\n${item.html_url}` };
          }
          requireNumber(args.number);
          if (action === 'comment') {
            if (!args.body) return { content: 'body is required for comment.', isError: true };
            const ok = await approveMutation(ctx, {
              title: `comment on issue #${args.number} · ${repo}`,
              preview: truncateEnd(args.body, 3000, 'comment'),
            });
            if (!ok) return denied('Comment');
            const item = await client.addComment(repo, args.number, args.body, { signal: ctx.signal });
            return { content: `Commented on #${args.number}: ${item.html_url}` };
          }
          if (action === 'close' || action === 'reopen') {
            const ok = await approveMutation(ctx, {
              title: `${action} issue #${args.number} · ${repo}`,
              detail: 'This changes the issue state on GitHub.',
            });
            if (!ok) return denied(`${action} issue`);
            const item = await client.patchIssue(
              repo,
              args.number,
              { state: action === 'close' ? 'closed' : 'open' },
              { signal: ctx.signal },
            );
            return { content: `${action === 'close' ? 'Closed' : 'Reopened'} #${item.number}: ${item.html_url}` };
          }
          return { content: `Unknown action: ${action}`, isError: true };
        } catch (error) {
          return githubFailure(error);
        }
      },
    },
    {
      name: 'github_pr',
      permission: 'read',
      description:
        'List, read, create, comment on, review, merge, close, or inspect files in GitHub pull requests. '
        + 'Mutations require approval; merging is treated as destructive and highlighted.',
      parameters: {
        type: 'object',
        properties: {
          repo: REPO_PROP,
          action: {
            type: 'string',
            enum: ['list', 'get', 'files', 'create', 'comment', 'review', 'merge', 'close', 'reopen'],
            description: 'Operation. Default list.',
          },
          number: { type: 'integer', description: 'PR number for get/files/comment/review/merge/close/reopen.' },
          title: { type: 'string', description: 'Title for create.' },
          body: { type: 'string', description: 'Body for create/comment/review.' },
          head: { type: 'string', description: 'Source branch for create (owner:branch when not in this repo).' },
          base: { type: 'string', description: 'Target branch for create.' },
          draft: { type: 'boolean', description: 'Create as draft.' },
          event: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'], description: 'Review event.' },
          method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method. Default merge.' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'State filter for list.' },
          limit: { type: 'integer', description: 'List size (default 15).' },
        },
        required: ['repo'],
        additionalProperties: false,
      },
      async run(args, ctx) {
        try {
          const client = requireClient(connection);
          const repo = String(args.repo || '');
          const action = args.action || 'list';
          if (action === 'list') {
            const items = await client.pulls(repo, {
              state: args.state || 'open',
              limit: Number(args.limit) || 15,
              signal: ctx.signal,
            });
            return {
              content: items.length
                ? items.map((item) => `#${item.number} [${item.draft ? 'draft' : item.state}] ${item.title} · @${item.user?.login || '?'}\n  ${item.html_url}`).join('\n')
                : 'No pull requests.',
            };
          }
          if (action === 'get') {
            requireNumber(args.number);
            const item = await client.pull(repo, args.number, { signal: ctx.signal });
            return {
              content: [
                `#${item.number} ${item.title} [${item.state}${item.draft ? '/draft' : ''}]`,
                `${item.head?.ref} → ${item.base?.ref} · +${item.additions} −${item.deletions} in ${item.changed_files} files`,
                `Mergeable: ${item.mergeable ?? 'unknown'} · checks: ${item.mergeable_state || 'unknown'} · @${item.user?.login || '?'}`,
                `URL: ${item.html_url}`,
                '',
                truncateEnd(item.body || '(no body)', 20_000, 'PR body'),
              ].join('\n'),
            };
          }
          if (action === 'files') {
            requireNumber(args.number);
            const files = await client.pullFiles(repo, args.number, { signal: ctx.signal });
            const body = files.slice(0, 40).map((file) => {
              const patch = truncateEnd(file.patch || '', 1500, 'patch');
              return `${file.status} ${file.filename} (+${file.additions} −${file.deletions})\n${patch}`;
            }).join('\n\n');
            return {
              content: body || 'No changed files.',
              display: { summary: `${files.length} files` },
            };
          }
          if (action === 'create') {
            if (!args.title) return { content: 'title is required for create.', isError: true };
            if (!args.head) return { content: 'head is required for create.', isError: true };
            if (!args.base) return { content: 'base is required for create.', isError: true };
            const ok = await approveMutation(ctx, {
              title: `create PR · ${repo}`,
              detail: `${args.head} → ${args.base}\n${args.title}`,
              preview: truncateEnd(args.body || '', 3000, 'PR body'),
            });
            if (!ok) return denied('Pull request creation');
            const item = await client.createPull(repo, {
              title: args.title,
              head: args.head,
              base: args.base,
              body: args.body || '',
              draft: Boolean(args.draft),
              signal: ctx.signal,
            });
            return { content: `Created PR #${item.number}: ${item.title}\n${item.html_url}` };
          }
          requireNumber(args.number);
          if (action === 'comment' || action === 'review') {
            if (!args.body) return { content: 'body is required.', isError: true };
            const event = args.event || 'COMMENT';
            const ok = await approveMutation(ctx, {
              title: `${action} on PR #${args.number} · ${repo}`,
              detail: action === 'review' ? `Review event: ${event}${event === 'APPROVE' ? ' (approving a PR is a significant action)' : ''}` : '',
              preview: truncateEnd(args.body, 3000, 'comment'),
              danger: event === 'APPROVE',
            });
            if (!ok) return denied(`${action} on PR`);
            if (action === 'comment') {
              const item = await client.addComment(repo, args.number, args.body, { signal: ctx.signal });
              return { content: `Commented on PR #${args.number}: ${item.html_url}` };
            }
            const item = await client.reviewPull(repo, args.number, { event, body: args.body, signal: ctx.signal });
            return { content: `Submitted ${event} review on PR #${args.number}${item?.html_url ? `: ${item.html_url}` : ''}` };
          }
          if (action === 'merge') {
            const ok = await approveMutation(ctx, {
              title: `merge PR #${args.number} · ${repo}`,
              detail: `Merge method: ${args.method || 'merge'}. This changes the default branch.`,
              danger: true,
            });
            if (!ok) return denied('PR merge');
            const result = await client.mergePull(repo, args.number, {
              method: ['merge', 'squash', 'rebase'].includes(args.method) ? args.method : 'merge',
              signal: ctx.signal,
            });
            return { content: result?.message || `Merged PR #${args.number}.` };
          }
          if (action === 'close' || action === 'reopen') {
            const ok = await approveMutation(ctx, {
              title: `${action} PR #${args.number} · ${repo}`,
              detail: 'This changes the PR state on GitHub.',
            });
            if (!ok) return denied(`${action} PR`);
            const item = await client.patchPull(
              repo,
              args.number,
              { state: action === 'close' ? 'closed' : 'open' },
              { signal: ctx.signal },
            );
            return { content: `${action === 'close' ? 'Closed' : 'Reopened'} PR #${item.number}: ${item.html_url}` };
          }
          return { content: `Unknown action: ${action}`, isError: true };
        } catch (error) {
          return githubFailure(error);
        }
      },
    },
    {
      name: 'github_write_file',
      permission: 'network',
      description:
        'Create, update, or delete a single file in a GitHub repository with a commit. Shows a diff and requires approval. '
        + 'This commits directly to the chosen branch (use github_pr for review flow). Text files only.',
      parameters: {
        type: 'object',
        properties: {
          repo: REPO_PROP,
          action: { type: 'string', enum: ['write', 'delete'], description: 'Default write.' },
          path: { type: 'string', description: 'Repository file path.' },
          content: { type: 'string', description: 'Full new file content for write.' },
          message: { type: 'string', description: 'Commit message. Defaults to a generated message.' },
          branch: { type: 'string', description: 'Target branch. Defaults to the repository default branch.' },
        },
        required: ['repo', 'path'],
        additionalProperties: false,
      },
      async run(args, ctx) {
        try {
          const client = requireClient(connection);
          const repo = String(args.repo || '');
          if (!args.path) return { content: 'path is required.', isError: true };
          const action = args.action || 'write';
          if (action === 'write' && typeof args.content !== 'string') {
            return { content: 'content is required for write.', isError: true };
          }
          let existing = null;
          try {
            existing = await client.readFile(repo, args.path, args.branch || null, { signal: ctx.signal });
          } catch (error) {
            if (!(error instanceof GithubError) || error.status !== 404) throw error;
          }
          const diff = action === 'write'
            ? diffLines(existing?.content || '', args.content, { maxLines: 200 })
            : null;
          const ok = await approveMutation(ctx, {
            title: `${action} · ${repo}/${args.path}`,
            detail: `${args.message || '(default commit message)'}${args.branch ? `\nbranch: ${args.branch}` : ''}`,
            diff,
            preview: action === 'delete' ? truncateEnd(existing?.content || '', 3000, 'file') : '',
            danger: action === 'delete',
          });
          if (!ok) return denied('GitHub file change');

          if (action === 'delete') {
            const result = await client.deleteFile(repo, args.path, {
              message: args.message,
              branch: args.branch || null,
              signal: ctx.signal,
            });
            return { content: `Deleted ${repo}/${args.path} in commit ${result.commitSha?.slice(0, 7) || ''}${result.commitUrl ? `\n${result.commitUrl}` : ''}` };
          }
          const result = await client.writeFile(repo, args.path, args.content, {
            message: args.message,
            branch: args.branch || null,
            signal: ctx.signal,
          });
          return {
            content: `${result.created ? 'Created' : 'Updated'} ${repo}/${args.path} in commit ${result.commitSha?.slice(0, 7) || ''}${result.commitUrl ? `\n${result.commitUrl}` : ''}`,
            display: { summary: diff ? `+${diff.added} −${diff.removed}` : 'deleted', diff },
          };
        } catch (error) {
          return githubFailure(error);
        }
      },
    },
    {
      name: 'github_actions',
      permission: 'read',
      description: 'List GitHub Actions workflow runs or re-run a failed workflow. Re-running requires approval.',
      parameters: {
        type: 'object',
        properties: {
          repo: REPO_PROP,
          action: { type: 'string', enum: ['list', 'rerun'], description: 'Default list.' },
          branch: { type: 'string', description: 'Filter runs by branch for list.' },
          run_id: { type: 'integer', description: 'Workflow run id for rerun.' },
          limit: { type: 'integer', description: 'Number of runs (default 10).' },
        },
        required: ['repo'],
        additionalProperties: false,
      },
      async run(args, ctx) {
        try {
          const client = requireClient(connection);
          const repo = String(args.repo || '');
          const action = args.action || 'list';
          if (action === 'list') {
            const data = await client.workflowRuns(repo, {
              limit: Number(args.limit) || 10,
              branch: args.branch || null,
              signal: ctx.signal,
            });
            const runs = data.workflow_runs || [];
            return {
              content: runs.length
                ? runs.map((run) => `#${run.id} ${run.name} · ${run.status}/${run.conclusion || '-'} · ${run.head_branch} · ${run.created_at}\n  ${run.html_url}`).join('\n')
                : 'No workflow runs.',
            };
          }
          if (action === 'rerun') {
            if (!args.run_id) return { content: 'run_id is required for rerun.', isError: true };
            const ok = await approveMutation(ctx, {
              title: `rerun workflow #${args.run_id} · ${repo}`,
              detail: 'This triggers a new CI run on GitHub.',
            });
            if (!ok) return denied('Workflow rerun');
            await client.rerunWorkflow(repo, args.run_id, { signal: ctx.signal });
            return { content: `Requested a rerun of workflow run ${args.run_id}.` };
          }
          return { content: `Unknown action: ${action}`, isError: true };
        } catch (error) {
          return githubFailure(error);
        }
      },
    },
  ];
}

function requireClient(connection) {
  if (!connection.connected) {
    return (() => {
      throw new GithubError(
        'GitHub is not connected. Run `hasty github login`, set GITHUB_TOKEN, or authenticate the gh CLI.',
      );
    })();
  }
  return connection.client();
}

function requireNumber(value) {
  if (!Number.isInteger(Number(value)) || Number(value) <= 0) {
    throw new GithubError('A positive issue/PR number is required for this action.');
  }
}

async function approveMutation(ctx, { title, detail = '', preview = '', diff = null, danger = false }) {
  const decision = await ctx.approve({
    category: 'network',
    tool: 'github',
    title,
    detail,
    preview,
    diff,
    danger,
    alwaysKey: 'github_write',
  });
  return decision.allowed;
}

function denied(what) {
  return { content: `${what} denied by the user. Nothing was changed on GitHub.`, isError: true };
}

function githubFailure(error) {
  if (error instanceof GithubError) {
    return { content: error.message, isError: true };
  }
  return { content: `GitHub error: ${error.message}`, isError: true };
}
