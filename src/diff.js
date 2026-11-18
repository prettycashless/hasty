/**
 * Minimal line diff with common prefix/suffix trimming and bounded LCS.
 * Good enough for showing edits in a terminal without pulling in a dependency.
 */

export function diffLines(oldText, newText, {
  context = 3,
  maxLines = 200,
  maxCells = 1_500_000,
} = {}) {
  const oldLines = oldText === '' || oldText == null ? [] : String(oldText).split('\n');
  const newLines = newText === '' || newText == null ? [] : String(newText).split('\n');

  let prefix = 0;
  while (
    prefix < oldLines.length
    && prefix < newLines.length
    && oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const ops = [];

  for (let i = 0; i < prefix; i += 1) {
    ops.push({ type: 'equal', text: oldLines[i], oldLine: i + 1, newLine: i + 1 });
  }

  const cells = (oldMiddle.length + 1) * (newMiddle.length + 1);
  if (cells > maxCells) {
    for (let i = 0; i < oldMiddle.length; i += 1) {
      ops.push({ type: 'del', text: oldMiddle[i], oldLine: prefix + i + 1, newLine: null });
    }
    for (let i = 0; i < newMiddle.length; i += 1) {
      ops.push({ type: 'add', text: newMiddle[i], oldLine: null, newLine: prefix + i + 1 });
    }
  } else {
    ops.push(...lcsOps(oldMiddle, newMiddle, prefix));
  }

  for (let i = 0; i < suffix; i += 1) {
    const oldIndex = oldLines.length - suffix + i;
    const newIndex = newLines.length - suffix + i;
    ops.push({
      type: 'equal',
      text: oldLines[oldIndex],
      oldLine: oldIndex + 1,
      newLine: newIndex + 1,
    });
  }

  const added = ops.filter((op) => op.type === 'add').length;
  const removed = ops.filter((op) => op.type === 'del').length;
  const hunks = buildHunks(ops, context);
  const shown = [];
  let lines = 0;
  let truncated = false;
  for (const hunk of hunks) {
    if (lines + hunk.lines.length + 1 > maxLines) {
      truncated = true;
      break;
    }
    shown.push(hunk);
    lines += hunk.lines.length + 1;
  }

  return {
    hunks: shown,
    added,
    removed,
    truncated: truncated || shown.length < hunks.length,
    changeCount: added + removed,
  };
}

function lcsOps(oldLines, newLines, prefix) {
  const n = oldLines.length;
  const m = newLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({
        type: 'equal',
        text: oldLines[i],
        oldLine: prefix + i + 1,
        newLine: prefix + j + 1,
      });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', text: oldLines[i], oldLine: prefix + i + 1, newLine: null });
      i += 1;
    } else {
      ops.push({ type: 'add', text: newLines[j], oldLine: null, newLine: prefix + j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', text: oldLines[i], oldLine: prefix + i + 1, newLine: null });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'add', text: newLines[j], oldLine: null, newLine: prefix + j + 1 });
    j += 1;
  }
  return ops;
}

function buildHunks(ops, context) {
  const changed = ops
    .map((op, index) => (op.type === 'equal' ? -1 : index))
    .filter((index) => index >= 0);
  if (changed.length === 0) return [];

  const ranges = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(ops.length - 1, changed[0] + context);
  for (const index of changed.slice(1)) {
    if (index - end <= context * 2) {
      end = Math.min(ops.length - 1, index + context);
    } else {
      ranges.push([start, end]);
      start = Math.max(0, index - context);
      end = Math.min(ops.length - 1, index + context);
    }
  }
  ranges.push([start, end]);

  return ranges.map(([from, to]) => {
    const lines = ops.slice(from, to + 1);
    const oldStart = lines.find((line) => line.oldLine != null)?.oldLine ?? 0;
    const newStart = lines.find((line) => line.newLine != null)?.newLine ?? 0;
    return {
      oldStart,
      newStart,
      oldCount: lines.filter((line) => line.type !== 'add').length,
      newCount: lines.filter((line) => line.type !== 'del').length,
      lines,
    };
  });
}

/** Compact `+12 −3` style summary. */
export function diffSummary(diff) {
  const parts = [];
  if (diff.added) parts.push(`+${diff.added}`);
  if (diff.removed) parts.push(`−${diff.removed}`);
  return parts.join(' ') || 'no changes';
}

/**
 * A small, readable diff for an edit within a file. Used when the full-file
 * diff would be too noisy.
 */
export function renderSnippetDiff(oldString, newString) {
  const diff = diffLines(oldString, newString, { context: 2, maxLines: 60 });
  return diff;
}
