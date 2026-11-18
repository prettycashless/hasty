import { paint, PALETTE, SYMBOLS, theme } from '../theme.js';
import { sanitizeText } from '../util.js';

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;

const INLINE_RE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\[[^\]\n]*\]\([^)\n]*\)|\*[^*\n]+\*|_[^_\n]+_|https?:\/\/[^\s<>"]+)/g;

/**
 * Line-buffered streaming markdown renderer.
 * Input is sanitized (no ANSI injection) and indented under Hasty's gutter.
 */
export class MarkdownStream {
  constructor({ out = process.stdout, indent = '  ' } = {}) {
    this.out = out;
    this.indent = indent;
    this.buffer = '';
    this.inCode = false;
    this.codeLang = '';
    this.started = false;
    this.lastWasBlank = true;
    this.fenceToken = '```';
  }

  push(chunk) {
    this.buffer += String(chunk ?? '');
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const rawLine = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.renderLine(sanitizeText(rawLine));
    }
  }

  end() {
    if (this.buffer.length > 0) {
      this.renderLine(sanitizeText(this.buffer));
      this.buffer = '';
    }
    if (this.inCode) {
      this.inCode = false;
      this.write(`${theme.dim(`${SYMBOLS.boxBL}${SYMBOLS.boxH}${SYMBOLS.boxH}`)}`);
    }
  }

  write(line) {
    this.out.write(`${line}\n`);
  }

  renderLine(line) {
    const fence = line.match(FENCE_RE);
    if (fence) {
      if (!this.inCode) {
        this.inCode = true;
        this.fenceToken = fence[1];
        this.codeLang = fence[2] || '';
        this.started = true;
        this.lastWasBlank = false;
        const label = this.codeLang ? ` ${this.codeLang} ` : '';
        this.write(theme.dim(`${SYMBOLS.boxTL}${SYMBOLS.boxH}`) + theme.muted(label));
      } else if (line.trim().startsWith(this.fenceToken[0].repeat(3))) {
        this.inCode = false;
        this.codeLang = '';
        this.lastWasBlank = false;
        this.write(theme.dim(`${SYMBOLS.boxBL}${SYMBOLS.boxH}${SYMBOLS.boxH}`));
      }
      return;
    }

    if (this.inCode) {
      this.started = true;
      this.lastWasBlank = false;
      const content = line.length ? ` ${theme.codeLine(line)}` : '';
      this.write(`${theme.dim(SYMBOLS.boxV)}${content}`);
      return;
    }

    if (!line.trim()) {
      // Avoid a blank line before the response starts, and collapse runs.
      if (!this.started) return;
      if (this.lastWasBlank) return;
      this.lastWasBlank = true;
      this.write('');
      return;
    }

    this.started = true;
    this.lastWasBlank = false;

    if (HR_RE.test(line)) {
      this.write(theme.box(`${SYMBOLS.rule.repeat(42)}`));
      return;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = heading[1].length;
      const text = this.inline(heading[2]);
      if (level === 1) {
        this.write(theme.heading(text));
      } else if (level === 2) {
        this.write(`${theme.brand('▎')} ${paint(text, { fg: PALETTE.ember, bold: true })}`);
      } else {
        this.write(paint(text, { fg: PALETTE.rust, bold: true }));
      }
      return;
    }

    const quote = line.match(QUOTE_RE);
    if (quote) {
      this.write(`${theme.box(SYMBOLS.boxV)} ${theme.quote(this.inline(quote[1]))}`);
      return;
    }

    const list = line.match(LIST_RE);
    if (list) {
      const indent = list[1];
      const marker = list[2];
      let body = list[3];
      let prefix;
      const checkbox = body.match(/^\[([ xX])\]\s+(.*)$/);
      if (checkbox) {
        const checked = checkbox[1].toLowerCase() === 'x';
        prefix = checked ? theme.success('☑') : theme.dim('☐');
        body = checkbox[2];
      } else if (/^\d/.test(marker)) {
        prefix = theme.primary(marker);
      } else {
        prefix = theme.primary(SYMBOLS.bullet);
      }
      this.write(`${indent}${prefix} ${this.inline(body)}`);
      return;
    }

    this.write(this.inline(line));
  }

  inline(text) {
    let out = '';
    let last = 0;
    INLINE_RE.lastIndex = 0;
    let match;
    while ((match = INLINE_RE.exec(text)) !== null) {
      out += text.slice(last, match.index);
      const token = match[0];
      if (token.startsWith('`') && token.endsWith('`')) {
        out += theme.code(token.slice(1, -1));
      } else if (token.startsWith('**') && token.endsWith('**')) {
        out += paint(this.inline(token.slice(2, -2)), { bold: true });
      } else if (token.startsWith('__') && token.endsWith('__')) {
        out += paint(this.inline(token.slice(2, -2)), { bold: true });
      } else if (token.startsWith('~~') && token.endsWith('~~')) {
        out += paint(token.slice(2, -2), { dim: true, fg: PALETTE.muted });
      } else if (token.startsWith('[') && token.includes('](')) {
        const split = token.indexOf('](');
        const label = token.slice(1, split);
        const url = token.slice(split + 2, -1);
        out += theme.link(label);
        if (url && url !== label) out += ` ${theme.dim(`(${url})`)}`;
      } else if (token.startsWith('*') && token.endsWith('*') && token.length > 2) {
        out += paint(this.inline(token.slice(1, -1)), { italic: true });
      } else if (token.startsWith('_') && token.endsWith('_') && token.length > 2) {
        out += paint(this.inline(token.slice(1, -1)), { italic: true });
      } else if (/^https?:\/\//.test(token)) {
        let url = token;
        let suffix = '';
        while (url && /[),.;:!?]$/.test(url)) {
          suffix = url.slice(-1) + suffix;
          url = url.slice(0, -1);
        }
        out += theme.link(url) + suffix;
      } else {
        out += token;
      }
      last = match.index + token.length;
    }
    out += text.slice(last);
    return out;
  }
}
