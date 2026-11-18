import readline from 'node:readline';
import { theme } from '../theme.js';

/**
 * Thin wrapper around Node's readline with Hasty's styling, history,
 * tab completion, approval-friendly interrupts, and masked secret input.
 */
export class Prompter {
  constructor({
    input = process.stdin,
    output = process.stdout,
    history = [],
    completer = null,
  } = {}) {
    this.input = input;
    this.output = output;
    this.completer = completer;
    this.pending = null;
    this.lastInterrupted = false;
    this.closed = false;
    this.onSigint = null;
    this.rl = readline.createInterface({
      input,
      output,
      terminal: Boolean(input.isTTY && output.isTTY),
      history: Array.isArray(history) ? history.slice(0, 500) : [],
      removeHistoryDuplicates: true,
      completer: (line) => this.complete(line),
    });
    this.rl.on('SIGINT', () => this.handleSigint());
    this.rl.on('close', () => {
      this.closed = true;
      if (this.pending) {
        const pending = this.pending;
        this.pending = null;
        pending.resolve(null);
      }
    });
  }

  setCompleter(fn) {
    this.completer = fn;
  }

  complete(line) {
    if (!this.completer) return [[], line];
    try {
      const result = this.completer(line);
      return Array.isArray(result) ? result : [[], line];
    } catch {
      return [[], line];
    }
  }

  handleSigint() {
    if (this.onSigint?.() === true) return;
    this.lastInterruptAt = Date.now();
    try {
      this.rl.write(null, { ctrl: true, name: 'u' });
    } catch {
      // The line may not be editable.
    }
    if (this.pending) {
      this.pending.interrupted = true;
      this.output.write('^C\n');
      try {
        this.rl.write('\n');
      } catch {
        this.pending.resolve(null);
        this.pending = null;
      }
    } else {
      this.output.write(`\n  ${theme.dim('Use /exit or Ctrl+D to quit.')}\n`);
    }
  }

  question(question) {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve(null);
        return;
      }
      this.pending = { resolve, interrupted: false };
      this.rl.question(question, (answer) => {
        const pending = this.pending;
        this.pending = null;
        if (pending?.interrupted) this.lastInterrupted = true;
        resolve(answer);
      });
    });
  }

  /**
   * Ask a question. Returns the trimmed answer, the default, the onInterrupt
   * value for Ctrl+C, or null on EOF.
   */
  async ask(question, {
    defaultValue = '',
    validate = null,
    onInterrupt = '',
  } = {}) {
    while (!this.closed) {
      this.lastInterrupted = false;
      const raw = await this.question(question);
      if (raw == null) return null;
      if (this.lastInterrupted) {
        this.lastInterrupted = false;
        return onInterrupt;
      }
      const value = raw.trim();
      if (!value) return defaultValue;
      if (!validate || validate(value)) return value;
      this.output.write(`  ${theme.warn('Invalid choice.')}\n`);
    }
    return null;
  }

  async readLine(prompt) {
    return this.ask(prompt, { onInterrupt: '' });
  }

  /** Masked input for API keys and tokens. */
  async secret(question) {
    if (!this.input.isTTY) {
      return this.question(question).then((answer) => answer);
    }
    this.output.write(question);
    this.rl.pause();
    const stdin = this.input;
    const wasRaw = Boolean(stdin.isRaw);
    let value = '';
    let stars = 0;
    let escapeState = false;

    return new Promise((resolve) => {
      const finish = (result) => {
        stdin.removeListener('data', onData);
        try {
          stdin.setRawMode(Boolean(wasRaw));
        } catch {
          // Not all streams support raw mode.
        }
        if (result == null) this.output.write('^C\n');
        else this.output.write('\n');
        this.rl.resume();
        resolve(result);
      };

      const onData = (chunk) => {
        const text = chunk.toString('utf8');
        for (const char of Array.from(text)) {
          if (escapeState) {
            if (/[A-Za-z~]$/.test(char)) escapeState = false;
            continue;
          }
          if (char === '\u001b') {
            escapeState = true;
            continue;
          }
          if (char === '\r' || char === '\n') {
            finish(value.trim() ? value.trim() : null);
            return;
          }
          if (char === '\u0003') {
            finish(null);
            return;
          }
          if (char === '\u007f' || char === '\b') {
            if (value.length > 0) {
              value = Array.from(value).slice(0, -1).join('');
              if (stars > 0) {
                stars -= 1;
                this.output.write('\b \b');
              }
            }
            continue;
          }
          if (/[\u0000-\u001f]/.test(char)) continue;
          value += char;
          stars += 1;
          this.output.write('*');
        }
      };

      try {
        stdin.setRawMode(true);
      } catch {
        // If raw mode fails, fall back to a normal question.
        stdin.removeListener('data', onData);
        this.rl.resume();
        this.question(question).then((answer) => resolve(answer && answer.trim()));
        return;
      }
      stdin.resume();
      stdin.on('data', onData);
      stdin.once('error', () => finish(null));
    });
  }

  write(text) {
    this.output.write(text);
  }

  getHistory() {
    return [...(this.rl.history || [])];
  }

  close() {
    if (!this.closed) {
      try {
        this.rl.close();
      } catch {
        // Already closed.
      }
    }
  }
}
