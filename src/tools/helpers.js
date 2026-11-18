import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configPath, hastyHome } from '../config.js';
import {
  displayPath,
  escapeRegExp,
  globToRegExp,
  isBinaryBuffer,
  isSubPath,
  toPosix,
} from '../util.js';

export const DEFAULT_IGNORES = [
  '.git/',
  '.hg/',
  '.svn/',
  'node_modules/',
  'bower_components/',
  '.pnpm-store/',
  '.yarn/',
  'vendor/',
  'target/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  'coverage/',
  '.nyc_output/',
  '.turbo/',
  '.parcel-cache/',
  '.cache/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  '.gradle/',
  '.idea/',
  '.vscode/',
  '.DS_Store',
  'Thumbs.db',
];

/** Build ignore rules from defaults, .gitignore, and .hastyignore. */
export async function loadIgnoreRules(cwd) {
  const raw = [...DEFAULT_IGNORES];
  for (const file of ['.gitignore', '.hastyignore']) {
    try {
      const content = await fsp.readFile(path.join(cwd, file), 'utf8');
      raw.push(...content.split(/\r?\n/));
    } catch {
      // The file is optional.
    }
  }
  const rules = [];
  for (const line of raw) {
    const rule = parseIgnoreRule(line);
    if (rule) rules.push(rule);
  }
  return rules;
}

function parseIgnoreRule(line) {
  let value = String(line ?? '').trim();
  if (!value || value.startsWith('#')) return null;
  let negate = false;
  if (value.startsWith('!')) {
    negate = true;
    value = value.slice(1);
  }
  if (!value) return null;
  const dirOnly = value.endsWith('/');
  if (dirOnly) value = value.slice(0, -1);
  let anchored = value.startsWith('/');
  if (anchored) value = value.slice(1);
  const hasSlash = value.includes('/');
  const fragment = globFragmentForIgnore(value);
  if (!fragment) return null;
  const pattern = hasSlash || anchored
    ? new RegExp(`^${fragment}(?:/|$)`)
    : new RegExp(`(?:^|/)${fragment}(?:/|$)`);
  return { pattern, negate, dirOnly, hasSlash, anchored, dir: dirOnly };
}

function globFragmentForIgnore(glob) {
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
      if (close !== -1) {
        let cls = glob.slice(i + 1, close);
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        out += `[${cls}]`;
        i = close + 1;
        continue;
      }
    }
    out += escapeRegExp(ch);
    i += 1;
  }
  return out;
}

export function isIgnored(relPath, isDir, rules) {
  const rel = toPosix(relPath).replace(/^\.\//, '');
  if (!rel || rel === '.') return false;
  let ignored = false;
  for (const rule of rules) {
    if (!rule.pattern.test(rel)) continue;
    ignored = !rule.negate;
  }
  return ignored;
}

/** Depth-first walk that does not follow directory symlinks. */
export async function* walkFiles(root, {
  rules = [],
  maxFiles = 20_000,
  maxDepth = 30,
  includeDirs = false,
} = {}) {
  const stack = [{ dir: path.resolve(root), depth: 0 }];
  let count = 0;
  while (stack.length > 0 && count < maxFiles) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, full));
      const isDir = entry.isDirectory();
      if (isIgnored(rel, isDir, rules)) continue;
      if (isDir) {
        if (includeDirs) yield { full, rel, isDir: true, depth: depth + 1 };
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        count += 1;
        yield { full, rel, isDir: false, depth: depth + 1 };
        if (count >= maxFiles) return;
      }
    }
  }
}

const PROTECTED = () => {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return [
    configPath(),
    path.join(hastyHome(), 'config.json'),
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.aws', 'credentials'),
    path.join(home, '.aws', 'config'),
    path.join(home, '.netrc'),
    path.join(home, '.config', 'gh', 'hosts.yml'),
    path.join(home, '.docker', 'config.json'),
    path.join(home, '.kube', 'config'),
    path.join(appData, 'Microsoft', 'Credentials'),
    path.join(localAppData, 'Microsoft', 'Credentials'),
    path.join(appData, 'gcloud'),
    path.join(home, '.config', 'gcloud'),
  ];
};

export function isProtectedPath(file) {
  const resolved = path.resolve(file);
  for (const protectedPath of PROTECTED()) {
    if (isSubPath(protectedPath, resolved) || sameFile(protectedPath, resolved)) {
      return true;
    }
  }
  return false;
}

function sameFile(a, b) {
  const norm = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  return norm(path.resolve(a)) === norm(path.resolve(b));
}

export function assertAccessible(file) {
  if (isProtectedPath(file)) {
    throw new Error(
      `Refusing to access ${file}. Hasty protects credential stores and its own API-key config.`,
    );
  }
}

export function resolveToolPath(cwd, input, { defaultPath = '.' } = {}) {
  let value = String(input || defaultPath);
  if (value === '~') value = os.homedir();
  else if (value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(cwd, value);
}

export function outsideWorkspace(ctx, file) {
  return !isSubPath(ctx.cwd, file);
}

export function rel(ctx, file) {
  return displayPath(ctx.cwd, file);
}

export function readFileSafe(file, maxBytes = 2_000_000) {
  return fsp.stat(file).then(async (stat) => {
    if (!stat.isFile()) throw new Error(`${file} is not a regular file.`);
    if (stat.size > maxBytes) {
      throw new Error(`${file} is ${stat.size} bytes; use read_file with an offset or search it instead.`);
    }
    const buffer = await fsp.readFile(file);
    if (isBinaryBuffer(buffer)) throw new Error(`${file} looks like a binary file.`);
    return buffer.toString('utf8');
  });
}

export function globMatches(pattern, relPath) {
  try {
    return globToRegExp(pattern).test(toPosix(relPath).replace(/^\.\//, ''));
  } catch {
    return false;
  }
}

export function summarizeMatches(files, total, max) {
  if (total === 0) return 'No matching files.';
  const lines = files.slice(0, max);
  if (total > max) lines.push(`… ${total - max} more matches (narrow the pattern or raise max_results).`);
  return lines.join('\n');
}

export function toAbsoluteCwd(cwd) {
  return path.resolve(cwd);
}

export function fileExistsSync(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}
