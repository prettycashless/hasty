import fsp from 'node:fs/promises';
import { runShell } from '../shell.js';
import {
  catastrophicReason,
  dangerousCommandReason,
} from '../approvals.js';
import { firstLine, formatDuration, truncateMiddle } from '../util.js';
import { outsideWorkspace, rel, resolveToolPath } from './helpers.js';

export function createShellTool(shell) {
  return {
    name: 'run_command',
    permission: 'shell',
    description:
      'Run a shell command in the project and return stdout, stderr, and the exit code. '
      + 'This is not interactive: use non-interactive flags and avoid editors/pagers. '
      + `The shell is ${shell.description}. ${shell.syntax} `
      + 'Requires approval by default. Use for tests, builds, package managers, git, and diagnostics.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command line to execute.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the project directory.' },
        timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (max 900000). Default 120000.' },
        description: { type: 'string', description: 'Short explanation shown in the approval prompt.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const command = String(args.command || '').trim();
      if (!command) return { content: 'command is required.', isError: true };
      const cwd = resolveToolPath(ctx.cwd, args.cwd || '.');
      try {
        const stat = await fsp.stat(cwd);
        if (!stat.isDirectory()) {
          return { content: `${rel(ctx, cwd)} is not a directory.`, isError: true };
        }
      } catch {
        return { content: `Working directory does not exist: ${rel(ctx, cwd)}`, isError: true };
      }

      const blocked = catastrophicReason(command);
      if (blocked) {
        return { content: blocked, isError: true };
      }
      const danger = dangerousCommandReason(command);
      const decision = await ctx.approve({
        category: 'shell',
        tool: 'run_command',
        title: `run · ${firstLine(command, 60)}`,
        detail: `${args.description ? `${args.description}\n` : ''}${shell.label} in ${rel(ctx, cwd)}\n$ ${command}`,
        outside: outsideWorkspace(ctx, cwd),
        danger: Boolean(danger),
        alwaysKey: 'shell',
      });
      if (!decision.allowed) {
        return {
          content: `Command denied: ${decision.reason}. It was not executed.`,
          isError: true,
        };
      }

      const timeoutMs = Math.min(900_000, Math.max(1000, Number(args.timeout_ms) || 120_000));
      const result = await runShell(command, {
        cwd,
        shell,
        timeoutMs,
        maxOutput: ctx.maxOutput || 60_000,
        signal: ctx.signal,
      });

      const sections = [];
      if (result.error) sections.push(`spawn error: ${result.error}`);
      sections.push(`exit code: ${result.code == null ? '(none)' : result.code}`);
      sections.push(`duration: ${formatDuration(result.durationMs)}`);
      if (result.timedOut) sections.push(`timed out after ${formatDuration(timeoutMs)}`);
      if (result.aborted) sections.push('aborted by user');
      if (result.stdout) sections.push(`stdout:\n${result.stdout}`);
      if (result.stderr) sections.push(`stderr:\n${result.stderr}`);
      if (result.truncatedStdout || result.truncatedStderr) {
        sections.push('[output truncated by Hasty]');
      }
      if (!result.stdout && !result.stderr && !result.error) sections.push('(no output)');

      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
      return {
        content: truncateMiddle(sections.join('\n'), ctx.maxOutput || 60_000, 'command output'),
        isError: Boolean(result.error || result.timedOut || result.aborted || (result.code != null && result.code !== 0)),
        display: {
          summary: result.timedOut
            ? 'timed out'
            : result.aborted
              ? 'aborted'
              : `exit ${result.code ?? '?'} · ${formatDuration(result.durationMs)}`,
          preview: combined.trim() ? truncateMiddle(combined.trim(), 4000, 'preview') : '',
          previewError: Boolean(result.error || result.code !== 0 || result.timedOut),
        },
      };
    },
  };
}
