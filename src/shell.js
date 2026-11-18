import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { commandExists, findExisting, isWindows } from './util.js';

/**
 * Resolve the shell Hasty uses for run_command.
 *
 * On Windows, Git Bash is preferred when available because most coding models
 * are dramatically better at POSIX shell syntax than cmd.exe or PowerShell 5.
 * PowerShell / cmd remain available via config.shell.
 */
export function resolveShell(config = {}) {
  const requested = String(config.shell || 'auto').toLowerCase();

  if (!isWindows) {
    if (requested === 'auto') {
      const shell = process.env.SHELL || '';
      if (shell && fs.existsSync(shell) && /(?:bash|zsh|sh)$/.test(path.basename(shell))) {
        return unixShell(shell);
      }
      const bash = findExisting(['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']);
      return unixShell(bash || '/bin/sh');
    }
    if (requested === 'bash' || requested === 'sh' || requested === 'zsh') {
      const found = findExisting([
        `/bin/${requested}`,
        `/usr/bin/${requested}`,
        `/usr/local/bin/${requested}`,
      ]);
      return unixShell(found || `/bin/${requested}`);
    }
    if (path.isAbsolute(requested) && fs.existsSync(requested)) return unixShell(requested);
    return unixShell('/bin/sh');
  }

  if (requested === 'cmd') {
    return cmdShell(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe');
  }
  if (requested === 'powershell' || requested === 'windows-powershell') {
    return powershellShell(findPowershell() || 'powershell.exe');
  }
  if (requested === 'pwsh') {
    return powershellShell(findPwsh() || 'pwsh.exe');
  }
  if (requested === 'bash' || requested === 'git-bash') {
    const bash = findGitBash();
    return bash ? bashShell(bash) : cmdShell(process.env.ComSpec || 'cmd.exe');
  }
  if (path.isAbsolute(requested) && fs.existsSync(requested)) {
    const base = path.basename(requested).toLowerCase();
    if (base.startsWith('bash') || base === 'sh.exe') return bashShell(requested);
    if (base === 'pwsh.exe') return powershellShell(requested);
    if (base.startsWith('powershell')) return powershellShell(requested);
    if (base === 'cmd.exe') return cmdShell(requested);
    return bashShell(requested);
  }

  // auto
  const gitBash = findGitBash();
  if (gitBash) return bashShell(gitBash);
  const pwsh = findPwsh();
  if (pwsh) return powershellShell(pwsh);
  const powershell = findPowershell();
  if (powershell) return powershellShell(powershell);
  return cmdShell(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe');
}

function unixShell(binary) {
  return {
    kind: 'posix',
    binary,
    label: `${path.basename(binary)} (POSIX shell)`,
    syntax: 'POSIX shell syntax. Use forward-slash paths and standard Unix commands.',
    description: 'bash-compatible POSIX shell',
    args: (command) => ['-c', command],
  };
}

function bashShell(binary) {
  return {
    kind: 'bash',
    binary,
    label: `${path.basename(binary)} (Git Bash)`,
    syntax:
      'Git Bash on Windows. Use POSIX syntax, forward-slash paths (/c/Users/...), '
      + 'and standard Unix tools (ls, grep, cat, sed). Windows programs such as git, node, '
      + 'npm, python and cargo can be called normally. Use `powershell.exe -NoProfile -Command ...` '
      + 'when you specifically need PowerShell.',
    description: 'Git Bash (bash)',
    args: (command) => ['-c', command],
  };
}

function powershellShell(binary) {
  return {
    kind: 'powershell',
    binary,
    label: path.basename(binary, '.exe'),
    syntax:
      'PowerShell. Use PowerShell syntax and cmdlets. Windows PowerShell 5.1 does not '
      + 'support `&&`; use `;` or separate commands. Unix aliases such as ls/cat exist, '
      + 'but prefer Get-ChildItem/Get-Content when output matters.',
    description: path.basename(binary, '.exe') === 'pwsh' ? 'PowerShell 7' : 'Windows PowerShell',
    args: (command) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
  };
}

function cmdShell(binary) {
  return {
    kind: 'cmd',
    binary,
    label: 'cmd.exe',
    syntax:
      'cmd.exe on Windows. Use cmd syntax (dir, type, copy), `&&` for chaining, '
      + 'and backslash paths. Unix commands are not available unless installed separately.',
    description: 'Windows cmd.exe',
    args: (command) => ['/d', '/s', '/c', command],
  };
}

function findGitBash() {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.USERPROFILE || '', 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', 'bash.exe'),
  ];
  const existing = findExisting(candidates);
  if (existing) return existing;
  const result = spawnSync('where', ['bash.exe'], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
  });
  if (result.status === 0) {
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    const git = lines.find((line) => /[\\/]Git[\\/]/i.test(line));
    if (git && fs.existsSync(git)) return git;
  }
  return null;
}

function findPwsh() {
  const candidates = [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
  ];
  const existing = findExisting(candidates);
  if (existing) return existing;
  if (commandExists('pwsh.exe')) return 'pwsh.exe';
  return null;
}

function findPowershell() {
  const candidate = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  if (fs.existsSync(candidate)) return candidate;
  if (commandExists('powershell.exe')) return 'powershell.exe';
  return null;
}

export function shellEnv(extra = {}) {
  return {
    ...process.env,
    HASTY: '1',
    TERM: process.env.TERM || 'xterm-256color',
    ...extra,
  };
}

/** Kill a shell command and all of its descendants. */
export function killTree(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (isWindows) {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 10_000,
      });
    } catch {
      try {
        child.kill('SIGKILL');
      } catch { /* already gone */ }
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch { /* already gone */ }
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch { /* already gone */ }
  }, 1500).unref?.();
}

/**
 * Run a command non-interactively and collect output.
 * Returns { code, signal, stdout, stderr, timedOut, aborted, durationMs }.
 */
export function runShell(command, {
  cwd,
  shell,
  timeoutMs = 120_000,
  maxOutput = 60_000,
  signal,
  env,
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(shell.binary, shell.args(command), {
      cwd,
      env: shellEnv(env),
      windowsHide: true,
      detached: !isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncatedStdout = false;
    let truncatedStderr = false;
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const append = (target, chunk) => {
      const text = chunk.toString('utf8');
      if (target === 'stdout') {
        stdoutBytes += Buffer.byteLength(text);
        if (stdout.length < maxOutput) {
          const remaining = maxOutput - stdout.length;
          stdout += text.slice(0, remaining);
          if (text.length > remaining) truncatedStdout = true;
        } else {
          truncatedStdout = true;
        }
      } else {
        stderrBytes += Buffer.byteLength(text);
        if (stderr.length < maxOutput) {
          const remaining = maxOutput - stderr.length;
          stderr += text.slice(0, remaining);
          if (text.length > remaining) truncatedStderr = true;
        } else {
          truncatedStderr = true;
        }
      }
    };

    child.stdout?.on('data', (chunk) => append('stdout', chunk));
    child.stderr?.on('data', (chunk) => append('stderr', chunk));

    const finish = (code, sig, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        signal: sig,
        stdout,
        stderr,
        stdoutBytes,
        stderrBytes,
        truncatedStdout,
        truncatedStderr,
        timedOut,
        aborted,
        error: error ? error.message : null,
        durationMs: Date.now() - started,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(1000, Math.min(Number(timeoutMs) || 120_000, 900_000)));

    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.on('error', (error) => {
      finish(null, null, error);
    });
    child.on('close', (code, sig) => {
      finish(code, sig);
    });
  });
}
