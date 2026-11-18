import {
  BANNER,
  PALETTE,
  SYMBOLS,
  banner as renderBanner,
  colorsEnabled,
  paint,
  theme,
} from '../theme.js';
import { MarkdownStream } from './markdown.js';
import {
  formatDuration,
  formatNumber,
  formatTokens,
  sanitizeText,
  termWidth,
  truncateEnd,
} from '../util.js';

export class Renderer {
  constructor({ out = process.stdout, config = {}, quiet = false } = {}) {
    this.out = out;
    this.config = config;
    this.quiet = quiet;
    this.isTTY = Boolean(out.isTTY);
    this.markdown = null;
    this.spinnerTimer = null;
    this.spinnerIndex = 0;
    this.spinnerLabel = '';
    this.turnHeaderShown = false;
    this.turnStart = 0;
    this.hasOutput = false;
  }

  write(text) {
    this.out.write(text);
  }

  line(text = '') {
    this.out.write(`${text}\n`);
  }

  banner({ version, provider, model, cwd, branch, approvalMode, resumed = false }) {
    if (this.config.ui?.showBanner === false) return;
    this.line();
    this.line(renderBanner());
    this.line();
    this.line(
      `  ${theme.accent('terminal coding agent')} ${theme.dim('·')} ${theme.dim(`v${version}`)} `
      + `${theme.dim('·')} ${theme.dim('bring your own key')}`,
    );
    const keyInfo = provider.keyless ? theme.muted('local') : theme.muted(provider.keyPreview || 'no key');
    this.line(
      `  ${theme.dim('model')} ${theme.bright(model)} ${theme.dim('· key')} ${keyInfo} `
      + `${theme.dim('· approvals')} ${theme.warn(approvalMode)}`,
    );
    this.line(
      `  ${theme.dim('cwd')} ${theme.text(shortCwd(cwd))}`
      + `${branch ? ` ${theme.dim('·')} ${theme.muted(`${SYMBOLS.branch} ${branch}`)}` : ''}`,
    );
    if (resumed) {
      this.line(`  ${theme.warn('resumed session')} ${theme.dim('· /clear for a fresh start')}`);
    }
    this.line();
    this.line(
      `  ${theme.dim('Type a request,')} ${theme.dim('@file to attach,')} ${theme.dim('!cmd to run shell,')} `
      + `${theme.dim('/help for commands.')}`,
    );
    this.line();
  }

  beginTurn() {
    this.turnStart = Date.now();
    this.turnHeaderShown = false;
    this.hasOutput = false;
  }

  endTurn() {
    this.stopSpinner();
    this.endAssistant();
  }

  assistantStart() {
    if (this.turnHeaderShown) return;
    this.turnHeaderShown = true;
    this.hasOutput = true;
    if (!this.quiet) {
      this.line();
      this.line(`  ${theme.brand('Hasty')}`);
    }
  }

  assistantDelta(text) {
    if (!text) return;
    this.stopSpinner();
    this.assistantStart();
    if (!this.markdown) this.markdown = new MarkdownStream({ out: this.out });
    this.markdown.push(text);
  }

  endAssistant() {
    if (this.markdown) {
      this.markdown.end();
      this.markdown = null;
    }
  }

  thinking(label = 'thinking') {
    this.stopSpinner();
    if (!this.isTTY || !colorsEnabled()) return;
    this.spinnerLabel = label;
    this.spinnerIndex = 0;
    this.spinnerStarted = Date.now();
    const draw = () => {
      const frame = SYMBOLS.spinner[this.spinnerIndex % SYMBOLS.spinner.length];
      this.spinnerIndex += 1;
      const elapsed = Date.now() - this.spinnerStarted;
      const suffix = elapsed > 3000 ? theme.dim(` ${(elapsed / 1000).toFixed(0)}s`) : '';
      this.write(`\r\u001b[2K  ${theme.primary(frame)} ${theme.dim(this.spinnerLabel)}${suffix}`);
    };
    draw();
    this.spinnerTimer = setInterval(draw, 90);
    this.spinnerTimer.unref?.();
  }

  stopSpinner() {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
      if (this.isTTY && colorsEnabled()) this.write('\r\u001b[2K');
      else this.write('');
    }
  }

  toolStart(name, summary = '') {
    this.stopSpinner();
    this.endAssistant();
    this.hasOutput = true;
    this.line(
      `  ${theme.tool(SYMBOLS.tool)} ${theme.toolName(name)}`
      + `${summary ? `  ${theme.dim(truncateEnd(summary, 160, 'summary'))}` : ''}`,
    );
  }

  toolEnd({ ok = true, summary = '', durationMs = null, display = null } = {}) {
    const bits = [];
    if (summary) bits.push(summary);
    if (durationMs != null) bits.push(formatDuration(durationMs));
    const icon = ok ? theme.success(SYMBOLS.check) : theme.error(SYMBOLS.cross);
    this.line(`  ${icon} ${theme.dim(bits.join(' · '))}`);
    if (display?.diff) this.diff(display.diff);
    if (display?.preview) this.preview(display.preview, { error: display.previewError || !ok });
    if (display?.todos) this.todo(display.todos);
  }

  preview(text, { error = false, maxLines = 18 } = {}) {
    if (this.config.ui?.showToolOutput === false || this.quiet) return;
    const clean = sanitizeText(text).trimEnd();
    if (!clean) return;
    const lines = clean.split('\n');
    const shown = lines.slice(0, maxLines);
    for (const line of shown) {
      this.line(`    ${error ? theme.error(SYMBOLS.boxV) : theme.dim(SYMBOLS.boxV)} ${theme.dim(line)}`);
    }
    if (lines.length > maxLines) {
      this.line(`    ${theme.dim(SYMBOLS.boxV)} ${theme.faint(`… ${lines.length - maxLines} more lines`)}`);
    }
  }

  diff(diff, { maxLines = 80 } = {}) {
    if (this.quiet || !diff?.hunks?.length) return;
    let printed = 0;
    for (const hunk of diff.hunks) {
      const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
      this.line(`    ${theme.diffHunk(header)}`);
      printed += 1;
      for (const line of hunk.lines) {
        if (printed >= maxLines) {
          this.line(`    ${theme.faint(`… diff truncated (${diff.added} added, ${diff.removed} removed)`)}`);
          return;
        }
        const oldNo = line.oldLine == null ? '    ' : String(line.oldLine).padStart(4);
        const newNo = line.newLine == null ? '    ' : String(line.newLine).padStart(4);
        if (line.type === 'add') {
          this.line(`    ${theme.dim(oldNo)} ${theme.dim(newNo)} ${theme.diffAdd(`+ ${line.text}`)}`);
        } else if (line.type === 'del') {
          this.line(`    ${theme.dim(oldNo)} ${theme.dim(newNo)} ${theme.diffDel(`- ${line.text}`)}`);
        } else {
          this.line(`    ${theme.dim(oldNo)} ${theme.dim(newNo)} ${theme.dim(`  ${line.text}`)}`);
        }
        printed += 1;
      }
    }
  }

  todo(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    this.line();
    this.line(`  ${theme.dim('plan')}`);
    for (const item of items) {
      const status = item.status || 'pending';
      const icon = status === 'completed'
        ? theme.success(SYMBOLS.check)
        : status === 'in_progress'
          ? theme.warn(SYMBOLS.arrow)
          : theme.dim('○');
      const content = status === 'completed'
        ? theme.dim(item.content)
        : status === 'in_progress'
          ? theme.text(item.content)
          : theme.muted(item.content);
      this.line(`  ${icon} ${content}`);
    }
    this.line();
  }

  info(message) {
    this.stopSpinner();
    this.line(`  ${theme.primary('›')} ${message}`);
  }

  success(message) {
    this.line(`  ${theme.success(SYMBOLS.check)} ${message}`);
  }

  warn(message) {
    this.line(`  ${theme.warn('!')} ${theme.warn(message)}`);
  }

  error(message) {
    this.stopSpinner();
    this.line();
    const text = sanitizeText(String(message ?? ''));
    for (const line of text.split('\n')) {
      this.line(`  ${theme.error(SYMBOLS.cross)} ${theme.error(line)}`);
    }
  }

  status({ model, usage, contextPct, elapsedMs, approvalMode, cwd }) {
    if (this.config.ui?.showUsage === false || this.quiet) return;
    const bits = [theme.muted(model)];
    if (usage?.total || usage?.input || usage?.output) {
      bits.push(theme.dim(`${formatTokens(usage.total || (usage.input + usage.output))} tokens`));
    }
    if (contextPct != null) bits.push(theme.dim(`context ${Math.min(999, Math.round(contextPct))}%`));
    if (elapsedMs != null) bits.push(theme.dim(formatDuration(elapsedMs)));
    bits.push(theme.dim(approvalMode));
    this.line();
    this.line(`  ${bits.join(theme.dim(' · '))}`);
  }

  approvalHeader(title, tone = 'blood') {
    const width = Math.min(termWidth() - 6, 64);
    const label = ` ${title} `;
    const side = Math.max(2, Math.floor((width - label.length) / 2));
    const line = `${SYMBOLS.boxH.repeat(side)}${label}${SYMBOLS.boxH.repeat(Math.max(2, width - side - label.length))}`;
    this.line();
    this.line(`  ${theme[tone === 'danger' ? 'error' : 'boxActive'](`${SYMBOLS.boxTL}${line}`)}`);
  }

  approvalLine(text, { error = false } = {}) {
    this.line(`  ${theme.box(SYMBOLS.boxV)} ${error ? theme.error(text) : text}`);
  }

  approvalFooter() {
    this.line(`  ${theme.box(`${SYMBOLS.boxBL}${SYMBOLS.boxH.repeat(5)}`)}`);
  }
}

function shortCwd(cwd) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length).replace(/\\/g, '/')}` || '~';
  }
  return cwd;
}

/**
 * Print-mode UI: raw assistant markdown to stdout, activity to stderr.
 * JSON mode is handled by JsonUI in cli.js.
 */
export class PlainUI {
  constructor({ out = process.stdout, err = process.stderr, config = {}, quiet = false } = {}) {
    this.out = out;
    this.err = err;
    this.config = config;
    this.quiet = quiet;
  }

  banner() {}

  beginTurn() {}

  endTurn() {}

  assistantDelta(text) {
    this.out.write(text);
  }

  assistantStart() {}

  endAssistant() {
    this.out.write('\n');
  }

  thinking() {}

  stopSpinner() {}

  toolStart(name, summary = '') {
    if (this.quiet) return;
    this.err.write(`${theme.dim(`${SYMBOLS.tool} ${name}${summary ? ` ${summary}` : ''}`)}\n`);
  }

  toolEnd({ ok = true, summary = '', durationMs = null }) {
    if (this.quiet) return;
    const bits = [summary, durationMs != null ? formatDuration(durationMs) : ''].filter(Boolean).join(' · ');
    this.err.write(`${ok ? theme.dim(`${SYMBOLS.check}`) : theme.error(SYMBOLS.cross)} ${theme.dim(bits)}\n`);
  }

  diff() {}

  todo() {}

  approvalHeader() {}
  approvalLine() {}
  approvalFooter() {}

  info(message) {
    if (!this.quiet) this.err.write(`${theme.dim(`› ${message}`)}\n`);
  }

  success(message) {
    if (!this.quiet) this.err.write(`${theme.dim(`${SYMBOLS.check} ${message}`)}\n`);
  }

  warn(message) {
    this.err.write(`${theme.warn(`! ${message}`)}\n`);
  }

  error(message) {
    this.err.write(`${theme.error(`${SYMBOLS.cross} ${message}`)}\n`);
  }

  status() {}
}

export class JsonUI {
  constructor({ out = process.stdout } = {}) {
    this.out = out;
  }

  emit(type, data = {}) {
    this.out.write(`${JSON.stringify({ type, ...data })}\n`);
  }

  banner() {}
  beginTurn() { this.emit('turn_start'); }
  endTurn() { this.emit('turn_end'); }
  assistantStart() {}
  assistantDelta(text) { this.emit('text', { text }); }
  endAssistant() {}
  thinking() {}
  stopSpinner() {}
  toolStart(name, summary) { this.emit('tool_call', { name, summary }); }
  toolEnd(data) {
    this.emit('tool_result', {
      ok: data.ok,
      summary: data.summary,
      durationMs: data.durationMs,
      ...(data.display?.todos ? { todos: data.display.todos } : {}),
    });
  }
  diff(diff) { this.emit('diff', { added: diff.added, removed: diff.removed, hunks: diff.hunks }); }
  todo(items) { this.emit('todo', { items }); }
  approvalHeader() {}
  approvalLine() {}
  approvalFooter() {}
  info(message) { this.emit('info', { message }); }
  success(message) { this.emit('info', { message }); }
  warn(message) { this.emit('warning', { message }); }
  error(message) { this.emit('error', { message }); }
  status(data) { this.emit('usage', data); }
}

/** Styled one-off messages used outside a turn. */
export function printKeyValue(label, value, { out = process.stdout } = {}) {
  out.write(`  ${theme.dim(label.padEnd(10))} ${value}\n`);
}

export function printHeader(title, { out = process.stdout } = {}) {
  out.write(`\n  ${theme.heading(title)}\n`);
}

export function printList(items, { out = process.stdout, numbered = false } = {}) {
  items.forEach((item, index) => {
    const prefix = numbered ? theme.primary(`${index + 1}.`) : theme.primary(SYMBOLS.bullet);
    out.write(`  ${prefix} ${item}\n`);
  });
}

export function printRule({ out = process.stdout, width = 48 } = {}) {
  out.write(`  ${theme.box(SYMBOLS.rule.repeat(width))}\n`);
}

export function formatCounts({ added = 0, removed = 0 }) {
  const parts = [];
  if (added) parts.push(`+${added}`);
  if (removed) parts.push(`−${removed}`);
  return parts.join(' ') || 'no changes';
}

export { formatNumber, PALETTE, BANNER, paint };
