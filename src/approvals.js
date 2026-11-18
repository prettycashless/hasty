import { theme } from './theme.js';
import { sanitizeText, truncateEnd } from './util.js';

const MODES = new Set(['ask', 'auto', 'yolo']);

export class ApprovalManager {
  constructor({
    config,
    renderer,
    prompter,
    interactive = Boolean(prompter),
    mode = null,
  } = {}) {
    this.config = config;
    this.renderer = renderer;
    this.prompter = prompter;
    this.interactive = interactive;
    this.mode = MODES.has(mode) ? mode : (config?.approvalMode || 'ask');
    this.sessionAllowed = new Set();
  }

  setMode(mode) {
    if (!MODES.has(mode)) throw new Error(`Unknown approval mode: ${mode}`);
    this.mode = mode;
    this.sessionAllowed.clear();
  }

  /**
   * Decide whether an action may run.
   * Returns { allowed, reason, always }.
   */
  async request({
    category = 'write',
    tool = 'tool',
    title = '',
    detail = '',
    preview = '',
    diff = null,
    outside = false,
    danger = false,
    blocked = null,
    alwaysKey = null,
  } = {}) {
    if (blocked) {
      this.renderer?.error(blocked);
      return { allowed: false, reason: blocked };
    }

    const key = alwaysKey || category;
    if (this.mode === 'yolo') return { allowed: true, reason: 'yolo mode' };
    if (category === 'read') return { allowed: true, reason: 'read-only' };
    if (this.sessionAllowed.has(key)) return { allowed: true, reason: 'allowed this session' };

    if (this.mode === 'auto') {
      if (category === 'write' && !outside) return { allowed: true, reason: 'auto mode' };
      if (category === 'shell' && !danger) return { allowed: true, reason: 'auto mode' };
    }

    if (!this.interactive || !this.prompter) {
      const reason = `Approval required for ${category} (${tool}), but Hasty is running non-interactively. `
        + 'Re-run interactively or pass --yes / --mode auto.';
      this.renderer?.warn(reason);
      return { allowed: false, reason };
    }

    this.renderApproval({ category, tool, title, detail, preview, diff, outside, danger });
    const answer = await this.prompter.ask(
      `  ${theme.warn('Allow?')} ${theme.dim('[y] once · [a] always this session · [n] deny')} `,
      {
        defaultValue: 'n',
        validate: (value) => ['y', 'yes', 'a', 'always', 'n', 'no', ''].includes(value.toLowerCase()),
        onInterrupt: 'n',
      },
    );
    const normalized = (answer || 'n').trim().toLowerCase();
    this.renderer?.line();
    if (normalized === 'a' || normalized === 'always') {
      this.sessionAllowed.add(key);
      return { allowed: true, reason: 'allowed for this session', always: true };
    }
    if (normalized === 'y' || normalized === 'yes') {
      return { allowed: true, reason: 'approved once' };
    }
    this.renderer?.warn('Denied. Hasty will not run that action.');
    return { allowed: false, reason: 'denied by user' };
  }

  renderApproval({ category, tool, title, detail, preview, diff, outside, danger }) {
    if (!this.renderer) return;
    const headerTitle = title || `${category} · ${tool}`;
    this.renderer.approvalHeader?.(headerTitle, danger ? 'danger' : 'blood');
    if (detail) {
      for (const line of sanitizeText(detail).split('\n').slice(0, 12)) {
        this.renderer.approvalLine?.(theme.text(line));
      }
    }
    if (outside) {
      this.renderer.approvalLine?.(theme.warn('This path is outside the workspace.'), { error: true });
    }
    if (danger) {
      this.renderer.approvalLine?.(theme.warn('This command looks destructive. Read it carefully.'), { error: true });
    }
    if (preview) {
      const clean = truncateEnd(sanitizeText(preview), 4000, 'preview');
      for (const line of clean.split('\n').slice(0, 30)) {
        this.renderer.approvalLine?.(theme.codeLine(line) || ' ');
      }
      if (clean.split('\n').length > 30) {
        this.renderer.approvalLine?.(theme.faint('… output truncated'));
      }
    }
    if (diff?.hunks?.length) {
      this.renderer.approvalLine?.(theme.faint(`diff: +${diff.added} −${diff.removed}`));
      let shown = 0;
      for (const hunk of diff.hunks) {
        this.renderer.approvalLine?.(theme.diffHunk(`@@ -${hunk.oldStart} +${hunk.newStart} @@`));
        for (const line of hunk.lines) {
          if (shown >= 30) break;
          if (line.type === 'add') this.renderer.approvalLine?.(theme.diffAdd(`+ ${line.text}`));
          else if (line.type === 'del') this.renderer.approvalLine?.(theme.diffDel(`- ${line.text}`));
          else this.renderer.approvalLine?.(theme.dim(`  ${line.text}`));
          shown += 1;
        }
        if (shown >= 30) break;
      }
    }
    this.renderer.approvalFooter?.();
  }
}

/** Detect commands that should never run, even in yolo mode. */
export function catastrophicReason(command) {
  const cmd = String(command || '').replace(/\s+/g, ' ').trim();
  const lower = cmd.toLowerCase();
  const patterns = [
    { re: /\brm\s+(?:-[a-z]*[rf][a-z]*\s+)+(?:--no-preserve-root\s+)?["']?(?:\/|~|\$home)["']?(?:\s|$|\*)/i, why: 'recursive deletion of / or your home directory' },
    { re: /\b(?:mkfs(?:\.[a-z0-9]+)?|wipefs)\b/i, why: 'filesystem formatting' },
    { re: /\bdd\s+[^\n]*of=\/dev\/(?:sd|nvme|hd|vd)/i, why: 'raw write to a disk device' },
    { re: />\s*\/dev\/(?:sd|nvme|hd|vd)[a-z0-9]*/i, why: 'raw write to a disk device' },
    { re: /\b(?:shutdown|reboot|halt|poweroff)\b/i, why: 'shutting down the machine' },
    { re: /\bsystemctl\s+(?:poweroff|reboot|halt)\b/i, why: 'shutting down the machine' },
    { re: /\binit\s+0\b/i, why: 'shutting down the machine' },
    { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: 'fork bomb' },
    { re: /\bformat\s+[a-z]:/i, why: 'formatting a drive' },
    { re: /\b(?:clear-disk|format-volume|remove-partition)\b/i, why: 'destructive Windows disk command' },
    { re: /\bdiskpart\b[\s\S]*\bclean\b/i, why: 'diskpart clean' },
    { re: /\bdel\s+\/[a-z]*[fs][a-z]*\s+["']?[a-z]:\\?(?:\s|$|\*)/i, why: 'deleting an entire drive' },
    { re: /\b(?:rd|rmdir)\s+\/s\s+\/q\s+["']?[a-z]:\\?(?:\s|$)/i, why: 'deleting an entire drive' },
    { re: /\bremove-item\b[^\n]*-recurse[^\n]*(?:[a-z]:\\?(?:\s|$)|~|\$home)/i, why: 'recursive deletion of a drive or home directory' },
    { re: /\bbcdedit\b/i, why: 'boot configuration modification' },
    { re: /\bvssadmin\s+delete\s+shadows\b/i, why: 'deleting filesystem snapshots' },
    { re: /\bkill\s+-9\s+1\b/i, why: 'killing init' },
    { re: /\bcipher\s+\/w:/i, why: 'wiping free space' },
  ];
  for (const pattern of patterns) {
    if (pattern.re.test(cmd) || pattern.re.test(lower)) {
      return `Blocked: this command looks like ${pattern.why}. Hasty will not run it.`;
    }
  }
  return null;
}

/** Commands that deserve a louder prompt even when auto mode would allow them. */
export function dangerousCommandReason(command) {
  const cmd = String(command || '').toLowerCase();
  const checks = [
    [/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/, 'recursive force delete'],
    [/\bgit\s+reset\s+--hard\b/, 'discards uncommitted work'],
    [/\bgit\s+clean\s+-[a-z]*[fd]/, 'deletes untracked files'],
    [/\bgit\s+push\s+(?:--force|-f)\b/, 'force-pushes history'],
    [/\bnpm\s+publish\b|\bpnpm\s+publish\b|\byarn\s+npm\s+publish\b/, 'publishes a package'],
    [/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/, 'pipes a download into a shell'],
    [/\bsudo\b/, 'runs with elevated privileges'],
    [/\bchmod\s+-r\s+777\b/, 'makes files world-writable'],
    [/\b(?:del|rd|rmdir)\s+\/[a-z]*[fs]/, 'recursive Windows deletion'],
    [/\breg\s+delete\b/, 'deletes registry keys'],
    [/\btaskkill\b[^\n]*\/f\b/, 'force-kills processes'],
    [/\b(?:npm|pnpm|yarn)\s+(?:install|add)\s+(?:-g|--global)\b/, 'installs a global package'],
    [/\bdrop\s+(?:database|table)\b/, 'drops database data'],
    [/\btruncate\s+table\b/, 'deletes table data'],
  ];
  for (const [re, why] of checks) {
    if (re.test(cmd)) return why;
  }
  return null;
}

export function approvalSummary({ category, tool, outside = false }) {
  const where = outside ? ' outside the workspace' : '';
  return `${category}${where} via ${tool}`;
}
