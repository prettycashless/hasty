import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { backupsDir, sessionsDir } from './config.js';
import {
  atomicWrite,
  ensureDir,
  isSubPath,
  readJson,
  sessionId,
  writeJsonAtomic,
} from './util.js';

const SESSION_SCHEMA = 1;
const MAX_BACKUP_BYTES = 4 * 1024 * 1024;

export function newSession({ cwd, provider, model }) {
  const now = new Date().toISOString();
  return {
    schema: SESSION_SCHEMA,
    id: sessionId(),
    title: '',
    cwd: path.resolve(cwd),
    provider,
    model,
    createdAt: now,
    updatedAt: now,
    messages: [],
    todos: [],
    usage: { input: 0, output: 0, total: 0 },
    backups: [],
    compactions: 0,
  };
}

export function normalizeSession(input) {
  const session = input && typeof input === 'object' ? input : null;
  if (!session || !Array.isArray(session.messages)) {
    throw new Error('Invalid session file: messages array is missing.');
  }
  return {
    schema: session.schema || SESSION_SCHEMA,
    id: String(session.id || sessionId()),
    title: String(session.title || ''),
    cwd: path.resolve(session.cwd || process.cwd()),
    provider: session.provider || '',
    model: session.model || '',
    createdAt: session.createdAt || new Date().toISOString(),
    updatedAt: session.updatedAt || new Date().toISOString(),
    messages: session.messages.filter(isValidMessage),
    todos: Array.isArray(session.todos) ? session.todos : [],
    usage: session.usage && typeof session.usage === 'object'
      ? {
        input: Number(session.usage.input) || 0,
        output: Number(session.usage.output) || 0,
        total: Number(session.usage.total) || 0,
      }
      : { input: 0, output: 0, total: 0 },
    backups: Array.isArray(session.backups) ? session.backups : [],
    compactions: Number(session.compactions) || 0,
  };
}

function isValidMessage(message) {
  return message
    && ['user', 'assistant', 'tool'].includes(message.role)
    && (typeof message.content === 'string' || Array.isArray(message.toolCalls));
}

export async function saveSession(session) {
  ensureDir(sessionsDir(), 0o700);
  session.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path.join(sessionsDir(), `${session.id}.json`), session, 0o600);
  return session;
}

export async function listSessions({ cwd = null, limit = 40 } = {}) {
  let entries;
  try {
    entries = await fsp.readdir(sessionsDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(sessionsDir(), entry.name));
  const sessions = [];
  for (const file of files) {
    try {
      const session = normalizeSession(await readJson(file));
      if (cwd && !samePath(session.cwd, cwd)) continue;
      sessions.push(summarize(session));
    } catch {
      // Ignore corrupt sessions so one bad file cannot break /sessions.
    }
  }
  sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return sessions.slice(0, limit);
}

export async function latestSession(cwd) {
  const sessions = await listSessions({ cwd, limit: 1 });
  return sessions[0] || null;
}

function summarize(session) {
  const lastUser = [...session.messages].reverse().find((message) => message.role === 'user');
  return {
    id: session.id,
    title: session.title || firstText(lastUser?.content) || 'Untitled session',
    cwd: session.cwd,
    provider: session.provider,
    model: session.model,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    usage: session.usage,
  };
}

function firstText(content) {
  if (typeof content === 'string') return content.split('\n')[0].slice(0, 80);
  return '';
}

export async function loadSession(idOrPath) {
  const sessionsRoot = path.resolve(sessionsDir());
  let file;
  if (idOrPath && idOrPath.includes(path.sep) || /\.json$/i.test(idOrPath || '')) {
    file = path.resolve(idOrPath);
  } else {
    if (!/^[A-Za-z0-9._-]+$/.test(String(idOrPath))) {
      throw new Error(`Invalid session id: ${idOrPath}`);
    }
    file = path.join(sessionsRoot, `${idOrPath}.json`);
  }
  if (!isSubPath(sessionsRoot, file) && !fs.existsSync(file)) {
    throw new Error(`Session not found: ${idOrPath}`);
  }
  const session = normalizeSession(await readJson(file));
  session._file = file;
  return session;
}

function samePath(a, b) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

/**
 * Save the previous contents of a file so Hasty can undo the change.
 * Called immediately before a write, after approval.
 */
export async function snapshotFile(session, filePath, oldContent) {
  const entry = {
    path: path.resolve(filePath),
    existed: oldContent != null,
    at: new Date().toISOString(),
    skipped: false,
    backupFile: null,
  };
  if (oldContent != null) {
    const buffer = Buffer.from(oldContent, 'utf8');
    if (buffer.length > MAX_BACKUP_BYTES) {
      entry.skipped = true;
    } else {
      const dir = path.join(backupsDir(), session.id);
      await ensureDir(dir, 0o700);
      const name = `${String(session.backups.length + 1).padStart(4, '0')}-${Date.now().toString(36)}.bak`;
      const backupFile = path.join(dir, name);
      await atomicWrite(backupFile, buffer, 0o600);
      entry.backupFile = backupFile;
    }
  }
  session.backups.push(entry);
  if (session.backups.length > 200) session.backups.shift();
  await saveSession(session);
  return entry;
}

export async function undoLast(session) {
  const entry = session.backups.pop();
  if (!entry) {
    return { ok: false, message: 'Nothing to undo in this session.' };
  }
  if (entry.skipped) {
    await saveSession(session);
    return {
      ok: false,
      message: `The previous version of ${entry.path} was too large to snapshot, so it cannot be restored.`,
    };
  }
  if (entry.existed) {
    if (!entry.backupFile || !fs.existsSync(entry.backupFile)) {
      await saveSession(session);
      return { ok: false, message: `Backup for ${entry.path} is missing.` };
    }
    const content = await fsp.readFile(entry.backupFile);
    await ensureDir(path.dirname(entry.path));
    await fsp.writeFile(entry.path, content);
  } else {
    try {
      await fsp.unlink(entry.path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (entry.backupFile) {
    try {
      await fsp.unlink(entry.backupFile);
    } catch {
      // Backup cleanup is best effort.
    }
  }
  await saveSession(session);
  return {
    ok: true,
    path: entry.path,
    existed: entry.existed,
    message: entry.existed
      ? `Restored ${entry.path}`
      : `Removed ${entry.path} (it did not exist before)`,
  };
}
