import fsp from 'node:fs/promises';
import path from 'node:path';
import { diffLines } from '../diff.js';
import {
  formatBytes,
  formatNumber,
  isBinaryBuffer,
  truncateEnd,
} from '../util.js';
import {
  assertAccessible,
  globMatches,
  isIgnored,
  outsideWorkspace,
  readFileSafe,
  rel,
  resolveToolPath,
  walkFiles,
} from './helpers.js';

const readParameters = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'File path, relative to the working directory or absolute.' },
    offset: { type: 'integer', description: 'First line to return (1-based). Default 1.' },
    limit: { type: 'integer', description: 'Maximum number of lines to return. Default 2000.' },
  },
  required: ['path'],
  additionalProperties: false,
};

const writeParameters = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'File path, relative to the working directory or absolute.' },
    content: { type: 'string', description: 'Full file content to write.' },
  },
  required: ['path', 'content'],
  additionalProperties: false,
};

const editParameters = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'File path, relative to the working directory or absolute.' },
    old_string: { type: 'string', description: 'Exact text to replace. Must be unique unless replace_all is true.' },
    new_string: { type: 'string', description: 'Replacement text. Use an empty string to delete the matched text.' },
    replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
  },
  required: ['path', 'old_string', 'new_string'],
  additionalProperties: false,
};

export function createFileTools() {
  return [
    {
      name: 'read_file',
      permission: 'read',
      description:
        'Read a text file from disk with line numbers. Use offset and limit for large files. '
        + 'Read a file before editing it. Binary files are rejected.',
      parameters: readParameters,
      async run(args, ctx) {
        const file = resolveToolPath(ctx.cwd, args.path);
        const denied = accessibilityResult(file);
        if (denied) return denied;
        let content;
        try {
          content = await readFileSafe(file, ctx.maxReadBytes || 4_000_000);
        } catch (error) {
          return { content: `Could not read ${rel(ctx, file)}: ${error.message}`, isError: true };
        }
        const allLines = content.split('\n');
        const total = allLines.length;
        const offset = Math.max(1, Number(args.offset) || 1);
        const limit = Math.min(5000, Math.max(1, Number(args.limit) || 2000));
        if (offset > total) {
          return {
            content: `${rel(ctx, file)} has ${total} lines; offset ${offset} is past the end.`,
            isError: true,
          };
        }
        const slice = allLines.slice(offset - 1, offset - 1 + limit);
        const pad = String(offset + slice.length - 1).length;
        let body = slice
          .map((line, index) => `${String(offset + index).padStart(pad)}  ${line}`)
          .join('\n');
        body = truncateEnd(body, ctx.maxOutput || 60_000, 'file content');
        const end = offset + slice.length - 1;
        const header = `${rel(ctx, file)} — lines ${offset}-${end} of ${total}`;
        const footer = end < total ? `\n[${total - end} more lines; use offset=${end + 1}]` : '';
        return {
          content: `${header}\n${body}${footer}`,
          display: { summary: `${formatNumber(slice.length)} lines${end < total ? ` of ${formatNumber(total)}` : ''}` },
        };
      },
    },
    {
      name: 'write_file',
      permission: 'write',
      description:
        'Create a new file or fully overwrite an existing one. Directories are created automatically. '
        + 'Prefer edit_file for small changes to existing files. Requires approval by default.',
      parameters: writeParameters,
      async run(args, ctx) {
        const file = resolveToolPath(ctx.cwd, args.path);
        const denied = accessibilityResult(file);
        if (denied) return denied;
        if (typeof args.content !== 'string') {
          return { content: 'content must be a string.', isError: true };
        }
        let oldContent = null;
        try {
          oldContent = await readFileSafe(file, 10_000_000);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            let isDirectory = false;
            try {
              isDirectory = (await fsp.stat(file)).isDirectory();
            } catch {
              // Report the original read error below.
            }
            if (isDirectory) {
              return { content: `${rel(ctx, file)} is a directory.`, isError: true };
            }
            return {
              content: `Could not prepare to write ${rel(ctx, file)}: ${error.message}. `
                + 'Use run_command or delete_file first if you really need to replace it.',
              isError: true,
            };
          }
        }
        if (oldContent === args.content) {
          return { content: `No changes: ${rel(ctx, file)} already has that content.` };
        }
        const diff = diffLines(oldContent ?? '', args.content, { context: 3, maxLines: 300 });
        const outside = outsideWorkspace(ctx, file);
        const decision = await ctx.approve({
          category: 'write',
          tool: 'write_file',
          title: `${oldContent == null ? 'create' : 'overwrite'} · ${rel(ctx, file)}`,
          detail: file,
          diff,
          outside,
          alwaysKey: 'write',
        });
        if (!decision.allowed) {
          return {
            content: `Write denied: ${decision.reason}. The file was not changed.`,
            isError: true,
          };
        }
        await ctx.snapshot(file, oldContent);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, args.content, 'utf8');
        const lines = args.content.split('\n').length;
        return {
          content: `${oldContent == null ? 'Created' : 'Wrote'} ${rel(ctx, file)} (${formatNumber(lines)} lines, ${formatBytes(Buffer.byteLength(args.content))}, +${diff.added} −${diff.removed}).`,
          display: {
            summary: `${oldContent == null ? 'created' : 'updated'} · +${diff.added} −${diff.removed}`,
            diff,
          },
        };
      },
    },
    {
      name: 'edit_file',
      permission: 'write',
      description:
        'Replace an exact string in an existing file. old_string must match exactly (including indentation) '
        + 'and must be unique unless replace_all is true. Use an empty new_string to delete text. '
        + 'Read the file first; re-read if the match fails. CRLF/LF differences are handled.',
      parameters: editParameters,
      async run(args, ctx) {
        const file = resolveToolPath(ctx.cwd, args.path);
        const denied = accessibilityResult(file);
        if (denied) return denied;
        let content;
        try {
          content = await readFileSafe(file, 10_000_000);
        } catch (error) {
          return { content: `Could not edit ${rel(ctx, file)}: ${error.message}`, isError: true };
        }
        if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
          return { content: 'old_string and new_string must be strings.', isError: true };
        }
        if (args.old_string === '') {
          return { content: 'old_string must not be empty. Use write_file to create content.', isError: true };
        }
        const applied = applyEdit(content, args.old_string, args.new_string, Boolean(args.replace_all));
        if (applied.error) {
          return {
            content: `Edit failed for ${rel(ctx, file)}: ${applied.error}`,
            isError: true,
          };
        }
        if (applied.content === content) {
          return { content: `No changes: the requested edit is already applied in ${rel(ctx, file)}.` };
        }
        const diff = diffLines(content, applied.content, { context: 3, maxLines: 300 });
        const outside = outsideWorkspace(ctx, file);
        const decision = await ctx.approve({
          category: 'write',
          tool: 'edit_file',
          title: `edit · ${rel(ctx, file)}`,
          detail: file,
          diff,
          outside,
          alwaysKey: 'write',
        });
        if (!decision.allowed) {
          return {
            content: `Edit denied: ${decision.reason}. The file was not changed.`,
            isError: true,
          };
        }
        await ctx.snapshot(file, content);
        await fsp.writeFile(file, applied.content, 'utf8');
        return {
          content: `Edited ${rel(ctx, file)} (${applied.count} replacement${applied.count === 1 ? '' : 's'}, +${diff.added} −${diff.removed}).`,
          display: {
            summary: `${applied.count} replacement${applied.count === 1 ? '' : 's'} · +${diff.added} −${diff.removed}`,
            diff,
          },
        };
      },
    },
    {
      name: 'delete_file',
      permission: 'write',
      description: 'Delete a single file. Requires approval. Directories are not deleted.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to delete.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const file = resolveToolPath(ctx.cwd, args.path);
        const denied = accessibilityResult(file);
        if (denied) return denied;
        let content;
        try {
          content = await readFileSafe(file, 10_000_000);
        } catch (error) {
          return { content: `Could not delete ${rel(ctx, file)}: ${error.message}`, isError: true };
        }
        const decision = await ctx.approve({
          category: 'write',
          tool: 'delete_file',
          title: `delete · ${rel(ctx, file)}`,
          detail: file,
          preview: content.split('\n').slice(0, 8).join('\n'),
          outside: outsideWorkspace(ctx, file),
          danger: true,
          alwaysKey: 'delete',
        });
        if (!decision.allowed) {
          return { content: `Delete denied: ${decision.reason}.`, isError: true };
        }
        await ctx.snapshot(file, content);
        await fsp.unlink(file);
        return {
          content: `Deleted ${rel(ctx, file)} (${formatBytes(Buffer.byteLength(content))}).`,
          display: { summary: 'deleted' },
        };
      },
    },
    {
      name: 'list_dir',
      permission: 'read',
      description:
        'List a directory as a small tree. Ignores build outputs, dependencies, and .git. '
        + 'Use depth 1 for a quick orientation and depth 2-3 for nearby structure.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path. Defaults to the working directory.' },
          depth: { type: 'integer', description: 'How many directory levels to show (1-3). Default 1.' },
          limit: { type: 'integer', description: 'Maximum entries to show. Default 250.' },
        },
        additionalProperties: false,
      },
      async run(args, ctx) {
        const dir = resolveToolPath(ctx.cwd, args.path || '.');
        let stat;
        try {
          stat = await fsp.stat(dir);
        } catch (error) {
          return { content: `Could not list ${rel(ctx, dir)}: ${error.message}`, isError: true };
        }
        if (!stat.isDirectory()) {
          return { content: `${rel(ctx, dir)} is not a directory. Use read_file.`, isError: true };
        }
        const depth = Math.min(3, Math.max(1, Number(args.depth) || 1));
        const limit = Math.min(1000, Math.max(1, Number(args.limit) || 250));
        const lines = [];
        let count = 0;
        let truncated = false;

        async function visit(current, currentDepth, prefix) {
          if (count >= limit) {
            truncated = true;
            return;
          }
          let entries;
          try {
            entries = await fsp.readdir(current, { withFileTypes: true });
          } catch {
            return;
          }
          entries.sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          for (const entry of entries) {
            if (count >= limit) {
              truncated = true;
              return;
            }
            const full = path.join(current, entry.name);
            const relativeToDir = path.relative(dir, full).replace(/\\/g, '/');
            const isDir = entry.isDirectory();
            if (isIgnored(relativeToDir, isDir, ctx.ignoreRules || [])) continue;
            count += 1;
            if (isDir) {
              lines.push(`${prefix}${entry.name}/`);
              if (currentDepth < depth) {
                await visit(full, currentDepth + 1, `${prefix}  `);
              }
            } else {
              let size = '';
              try {
                const fileStat = await fsp.stat(full);
                size = `  ${formatBytes(fileStat.size)}`;
              } catch {
                // Size is optional.
              }
              lines.push(`${prefix}${entry.name}${size}`);
            }
          }
        }

        await visit(dir, 1, '');
        const header = `${rel(ctx, dir)}/  (${count} ${count === 1 ? 'entry' : 'entries'})`;
        const body = lines.join('\n');
        return {
          content: `${header}\n${body}${truncated ? `\n… list truncated at ${limit} entries` : ''}`,
          display: { summary: `${count} entries` },
        };
      },
    },
    {
      name: 'glob_search',
      permission: 'read',
      description:
        'Find files by glob pattern (e.g. "**/*.ts", "src/**/*.test.js", "*.json"). '
        + 'Patterns without a slash match at any depth. Honors .gitignore and .hastyignore.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match against relative file paths.' },
          path: { type: 'string', description: 'Directory to search. Defaults to the working directory.' },
          max_results: { type: 'integer', description: 'Maximum results. Default 200.' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const base = resolveToolPath(ctx.cwd, args.path || '.');
        const max = Math.min(1000, Math.max(1, Number(args.max_results) || 200));
        const pattern = String(args.pattern || '').trim();
        if (!pattern) return { content: 'pattern is required.', isError: true };
        const anyDepth = !pattern.includes('/');
        const matches = [];
        let visited = 0;
        for await (const file of walkFiles(base, {
          rules: ctx.ignoreRules || [],
          maxFiles: 30_000,
          maxDepth: 25,
        })) {
          visited += 1;
          const relToBase = file.rel;
          const ok = globMatches(pattern, relToBase)
            || (anyDepth && globMatches(`**/${pattern}`, relToBase));
          if (ok) {
            matches.push(rel(ctx, file.full));
            if (matches.length >= max) break;
          }
        }
        matches.sort();
        const note = matches.length >= max ? `\n… stopped at ${max} results; narrow the pattern or raise max_results.` : '';
        return {
          content: matches.length
            ? `${matches.length} match${matches.length === 1 ? '' : 'es'} (${formatNumber(visited)} files scanned):\n${matches.join('\n')}${note}`
            : `No files matched "${pattern}" under ${rel(ctx, base)} (${formatNumber(visited)} files scanned).`,
          display: { summary: `${matches.length} matches` },
        };
      },
    },
    {
      name: 'grep_search',
      permission: 'read',
      description:
        'Search file contents with a regular expression (or fixed string). Returns file:line matches. '
        + 'Use this instead of recursive cat/grep. Honors .gitignore and .hastyignore, skips binaries.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for (or literal text when fixed=true).' },
          path: { type: 'string', description: 'Directory or file to search. Defaults to the working directory.' },
          glob: { type: 'string', description: 'Optional file glob filter, e.g. "**/*.ts".' },
          fixed: { type: 'boolean', description: 'Treat pattern as literal text. Default false.' },
          case_sensitive: { type: 'boolean', description: 'Case-sensitive search. Default false.' },
          max_results: { type: 'integer', description: 'Maximum matching lines. Default 120.' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const base = resolveToolPath(ctx.cwd, args.path || '.');
        const max = Math.min(1000, Math.max(1, Number(args.max_results) || 120));
        const fixed = Boolean(args.fixed);
        const caseSensitive = Boolean(args.case_sensitive);
        let regex;
        try {
          const source = fixed ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : String(args.pattern);
          regex = new RegExp(source, caseSensitive ? '' : 'i');
        } catch (error) {
          return { content: `Invalid regular expression: ${error.message}`, isError: true };
        }
        if (!args.pattern) return { content: 'pattern is required.', isError: true };

        const files = [];
        try {
          const stat = await fsp.stat(base);
          if (stat.isFile()) files.push({ full: base, rel: path.basename(base) });
          else {
            for await (const file of walkFiles(base, {
              rules: ctx.ignoreRules || [],
              maxFiles: 20_000,
              maxDepth: 25,
            })) {
              if (args.glob && !globMatches(String(args.glob), file.rel)) continue;
              files.push(file);
            }
          }
        } catch (error) {
          return { content: `Could not search ${rel(ctx, base)}: ${error.message}`, isError: true };
        }

        const results = [];
        let scanned = 0;
        let skipped = 0;
        for (const file of files) {
          if (results.length >= max) break;
          let buffer;
          try {
            const stat = await fsp.stat(file.full);
            if (stat.size > 2_000_000) {
              skipped += 1;
              continue;
            }
            buffer = await fsp.readFile(file.full);
          } catch {
            skipped += 1;
            continue;
          }
          if (isBinaryBuffer(buffer)) {
            skipped += 1;
            continue;
          }
          scanned += 1;
          const lines = buffer.toString('utf8').split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            if (results.length >= max) break;
            if (regex.test(lines[index])) {
              const display = lines[index].trim().slice(0, 300);
              results.push(`${rel(ctx, file.full)}:${index + 1}: ${display}`);
            }
            regex.lastIndex = 0;
          }
        }

        const note = results.length >= max ? `\n… stopped at ${max} matches; narrow the search.` : '';
        return {
          content: results.length
            ? `${results.length} match${results.length === 1 ? '' : 'es'} in ${formatNumber(scanned)} files:\n${results.join('\n')}${note}`
            : `No matches for ${fixed ? 'text' : 'pattern'} "${args.pattern}" (${formatNumber(scanned)} files scanned${skipped ? `, ${skipped} skipped` : ''}).`,
          display: { summary: `${results.length} matches` },
        };
      },
    },
  ];
}

/**
 * Apply an exact-string edit, tolerating CRLF/LF differences between the
 * model's strings and the file on disk.
 */
export function applyEdit(content, oldString, newString, replaceAll = false) {
  const fileCRLF = content.includes('\r\n');
  const normalize = (value) => String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const normalizedOld = normalize(oldString);
  const normalizedNew = normalize(newString);
  const candidates = [];
  const seen = new Set();
  const addCandidate = (value) => {
    if (!seen.has(value)) {
      seen.add(value);
      candidates.push(value);
    }
  };
  addCandidate(oldString);
  addCandidate(normalizedOld);
  if (fileCRLF) addCandidate(normalizedOld.replace(/\n/g, '\r\n'));

  let matched = null;
  let count = 0;
  for (const candidate of candidates) {
    const occurrences = countOccurrences(content, candidate);
    if (occurrences > 0) {
      matched = candidate;
      count = occurrences;
      break;
    }
  }

  if (!matched) {
    return {
      error: 'old_string was not found. The file may have changed, or the indentation/text does not match exactly. '
        + 'Re-read the relevant part of the file and retry.',
    };
  }
  if (count > 1 && !replaceAll) {
    return {
      error: `old_string occurs ${count} times. Add more surrounding context to make it unique, or set replace_all=true.`,
    };
  }

  const replacement = fileCRLF
    ? normalizedNew.replace(/\n/g, '\r\n')
    : normalizedNew;
  const updated = replaceAll
    ? content.split(matched).join(replacement)
    : content.replace(matched, () => replacement);
  return { content: updated, count: replaceAll ? count : 1 };
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function accessibilityResult(file) {
  try {
    assertAccessible(file);
    return null;
  } catch (error) {
    return { content: error.message, isError: true };
  }
}
