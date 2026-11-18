import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const isWindows = process.platform === 'win32';

const ESC = '\u001b';
const OSC_RE = new RegExp(`${ESC}\\][^\\u0007]*(?:\\u0007|${ESC}\\\\)`, 'g');
const CSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');
const OTHER_ESC_RE = new RegExp(`${ESC}[@-Z\\\\-_]`, 'g');

/** Remove ANSI/OSC sequences from a string. */
export function stripAnsi(input) {
  return String(input ?? '')
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(OTHER_ESC_RE, '');
}

/**
 * Make untrusted text safe for a terminal: normalize newlines, remove escape
 * sequences, control characters, and bidi overrides. Tabs are preserved.
 */
export function sanitizeText(input) {
  return String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(OTHER_ESC_RE, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
}

export function truncateMiddle(text, max, label = 'output') {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  const head = Math.max(1, Math.floor(max * 0.55));
  const tail = Math.max(1, max - head);
  const omitted = value.length - head - tail;
  return `${value.slice(0, head)}\n… [${omitted} chars of ${label} truncated] …\n${value.slice(-tail)}`;
}

export function truncateEnd(text, max, label = 'text') {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… [${value.length - max} chars of ${label} truncated]`;
}

export function firstLine(text, max = 120) {
  const line = String(text ?? '').split('\n', 1)[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function formatDuration(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(n / 60_000);
  const seconds = Math.round((n % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatNumber(n) {
  return new Intl.NumberFormat('en-US').format(Number(n) || 0);
}

export function formatTokens(n) {
  const value = Number(n) || 0;
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

export function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

export function isSubPath(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (!rel) return true;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

export function displayPath(cwd, target) {
  const resolved = path.resolve(target);
  if (isSubPath(cwd, resolved)) {
    const rel = toPosix(path.relative(cwd, resolved)) || '.';
    return rel;
  }
  const home = os.homedir();
  if (isSubPath(home, resolved)) {
    return `~/${toPosix(path.relative(home, resolved))}`;
  }
  return resolved;
}

export async function ensureDir(dir, mode = 0o700) {
  await fsp.mkdir(dir, { recursive: true, mode });
}

export function ensureDirSync(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

export async function atomicWrite(file, content, mode) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, content, mode == null ? undefined : { mode });
  await fsp.rename(tmp, file);
  if (mode != null) {
    try {
      await fsp.chmod(file, mode);
    } catch {
      // Windows does not implement POSIX modes; ignore.
    }
  }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) {
      const wrapped = new Error(`Invalid JSON in ${file}: ${error.message}`);
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
}

export async function writeJsonAtomic(file, value, mode) {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/** Escape a string for use inside a regular expression. */
export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Convert a glob to a RegExp matching a POSIX-style relative path. */
export function globToRegExp(glob, { nocase = false } = {}) {
  const source = toPosix(String(glob || '*')).replace(/^\.\//, '');
  const body = globFragment(source);
  return new RegExp(`^${body}$`, nocase ? 'i' : '');
}

function globFragment(glob) {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\[';
        i += 1;
        continue;
      }
      let cls = glob.slice(i + 1, close);
      if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
      out += `[${cls.replace(/\\/g, '\\\\')}]`;
      i = close + 1;
      continue;
    }
    if (ch === '{') {
      let depth = 0;
      let close = -1;
      for (let j = i; j < glob.length; j += 1) {
        if (glob[j] === '{') depth += 1;
        if (glob[j] === '}') {
          depth -= 1;
          if (depth === 0) {
            close = j;
            break;
          }
        }
      }
      if (close !== -1) {
        const inner = glob.slice(i + 1, close);
        const parts = splitTopLevel(inner);
        out += `(?:${parts.map((part) => globFragment(part)).join('|')})`;
        i = close + 1;
        continue;
      }
    }
    out += escapeRegExp(ch);
    i += 1;
  }
  return out;
}

function splitTopLevel(value) {
  const parts = [];
  let current = '';
  let depth = 0;
  for (const ch of value) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current || parts.length === 0) parts.push(current);
  return parts;
}

/** Shell-ish quoted argument splitter used for simple CLI parsing. */
export function splitArgs(input) {
  const args = [];
  let current = '';
  let quote = null;
  let escaped = false;
  let started = false;
  for (const ch of String(input)) {
    if (escaped) {
      current += ch;
      escaped = false;
      started = true;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) args.push(current);
  return args;
}

export function commandExists(command) {
  if (path.isAbsolute(command)) return fs.existsSync(command);
  const finder = isWindows ? 'where' : 'which';
  const result = spawnSync(finder, [command], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 3000,
  });
  return result.status === 0;
}

export function findExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function gitInfo(cwd) {
  try {
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null;
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    const status = spawnSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    const changed = status.status === 0
      ? status.stdout.split('\n').filter(Boolean).length
      : 0;
    return {
      branch: branch.status === 0 ? branch.stdout.trim() : '',
      changed,
    };
  } catch {
    return null;
  }
}

export function isBinaryBuffer(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return sample.includes(0);
}

export function maskSecret(secret) {
  const value = String(secret ?? '');
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function sessionId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

export function elapsed(start) {
  return Date.now() - start;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function termWidth() {
  const width = process.stdout.columns || 100;
  return clamp(width, 60, 140);
}

export async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

export function unique(values) {
  return [...new Set(values)];
}
