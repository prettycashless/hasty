/**
 * Hasty's dark-red terminal theme.
 *
 * Everything is truecolor ANSI. Color is disabled automatically when output
 * is not a TTY, when NO_COLOR is set, or on dumb terminals. FORCE_COLOR=1
 * overrides detection. HASTY_ASCII=1 swaps glyphs for ASCII fallbacks.
 */

export const PALETTE = {
  ember: '#ff5a5f',
  blood: '#c1121f',
  wine: '#8b0000',
  rust: '#b34242',
  ash: '#e8dada',
  muted: '#a18484',
  dim: '#6f4b4b',
  line: '#3b1717',
  gold: '#d6a05c',
  green: '#83aa72',
  greenBg: '#122011',
  redBg: '#2a0b0b',
  code: '#f0bdbd',
  codeBg: '#1c0d0d',
  userBg: '#1a0d0d',
};

const env = process.env;
let colorEnabled = Boolean(
  process.stdout?.isTTY
  && !env.NO_COLOR
  && env.TERM !== 'dumb'
  && env.CLICOLOR !== '0',
);
if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') colorEnabled = true;

const ESC = '\u001b[';
const RESET = `${ESC}0m`;

export function setColorEnabled(value) {
  colorEnabled = Boolean(value);
}

export function colorsEnabled() {
  return colorEnabled;
}

function hexToRgb(hex) {
  const clean = String(hex).replace('#', '');
  const value = Number.parseInt(clean, 16);
  if (!Number.isFinite(value)) return { r: 255, g: 255, b: 255 };
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function codes({ fg, bg, bold, dim, italic, underline, inverse }) {
  const parts = [];
  if (bold) parts.push('1');
  if (dim) parts.push('2');
  if (italic) parts.push('3');
  if (underline) parts.push('4');
  if (inverse) parts.push('7');
  if (fg) {
    const { r, g, b } = hexToRgb(fg);
    parts.push(`38;2;${r};${g};${b}`);
  }
  if (bg) {
    const { r, g, b } = hexToRgb(bg);
    parts.push(`48;2;${r};${g};${b}`);
  }
  return parts;
}

export function paint(text, style = {}) {
  const value = String(text ?? '');
  if (!colorEnabled || value === '') return value;
  const active = codes(style);
  if (active.length === 0) return value;
  return `${ESC}${active.join(';')}m${value}${RESET}`;
}

/** Apply a style to every line independently (safer for multi-line text). */
export function paintLines(text, style) {
  return String(text ?? '')
    .split('\n')
    .map((line) => paint(line, style))
    .join('\n');
}

const style = {
  brand: (text) => paint(text, { fg: PALETTE.ember, bold: true }),
  primary: (text) => paint(text, { fg: PALETTE.blood }),
  bright: (text) => paint(text, { fg: PALETTE.ember }),
  accent: (text) => paint(text, { fg: PALETTE.gold }),
  heading: (text) => paint(text, { fg: PALETTE.ember, bold: true }),
  text: (text) => paint(text, { fg: PALETTE.ash }),
  muted: (text) => paint(text, { fg: PALETTE.muted }),
  dim: (text) => paint(text, { fg: PALETTE.dim }),
  faint: (text) => paint(text, { fg: PALETTE.dim, dim: true }),
  success: (text) => paint(text, { fg: PALETTE.green }),
  warn: (text) => paint(text, { fg: PALETTE.gold }),
  error: (text) => paint(text, { fg: PALETTE.ember, bold: true }),
  code: (text) => paint(text, { fg: PALETTE.code, bg: PALETTE.codeBg }),
  codeLine: (text) => paint(text, { fg: PALETTE.code }),
  tool: (text) => paint(text, { fg: PALETTE.rust }),
  toolName: (text) => paint(text, { fg: PALETTE.ember }),
  link: (text) => paint(text, { fg: PALETTE.gold, underline: true }),
  quote: (text) => paint(text, { fg: PALETTE.muted, italic: true }),
  userPrompt: (text) => paint(text, { fg: PALETTE.ember, bold: true }),
  prompt: (text) => paint(text, { fg: PALETTE.ember }),
  box: (text) => paint(text, { fg: PALETTE.wine }),
  boxActive: (text) => paint(text, { fg: PALETTE.blood, bold: true }),
  diffAdd: (text) => paint(text, { fg: PALETTE.green }),
  diffDel: (text) => paint(text, { fg: PALETTE.ember }),
  diffHunk: (text) => paint(text, { fg: PALETTE.gold }),
  diffMeta: (text) => paint(text, { fg: PALETTE.muted }),
  selection: (text) => paint(text, { fg: PALETTE.ash, bg: PALETTE.wine }),
};

export const theme = style;

export const SYMBOLS = process.env.HASTY_ASCII
  ? {
      bullet: '-',
      tool: '>',
      check: 'ok',
      cross: 'x',
      spinner: ['|', '/', '-', '\\'],
      chevron: '>',
      rule: '-',
      boxTL: '+',
      boxTR: '+',
      boxBL: '+',
      boxBR: '+',
      boxH: '-',
      boxV: '|',
      arrow: '->',
      dot: '*',
      branch: 'git',
    }
  : {
      bullet: '•',
      tool: '⚒',
      check: '✔',
      cross: '✖',
      spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
      chevron: '›',
      rule: '─',
      boxTL: '╭',
      boxTR: '╮',
      boxBL: '╰',
      boxBR: '╯',
      boxH: '─',
      boxV: '│',
      arrow: '→',
      dot: '●',
      branch: '⑂',
    };

export function rule(width = 56, char = SYMBOLS.rule) {
  return theme.box(char.repeat(Math.max(4, width)));
}

export const BANNER = [
  ' ██╗  ██╗ █████╗ ███████╗████████╗██╗   ██╗',
  ' ██║  ██║██╔══██╗██╔════╝╚══██╔══╝╚██╗ ██╔╝',
  ' ███████║███████║███████╗   ██║    ╚████╔╝ ',
  ' ██╔══██║██╔══██║╚════██║   ██║     ╚██╔╝  ',
  ' ██║  ██║██║  ██║███████║   ██║      ██║   ',
  ' ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝   ╚═╝      ╚═╝   ',
];

/** Print the block-letter banner with a dark-red vertical gradient. */
export function banner() {
  const shades = ['#ff6b6b', '#f05252', '#d93838', '#bd2626', '#9c1616', '#7a0d0d'];
  const lines = BANNER.map((line, index) => paint(line, { fg: shades[index] || PALETTE.wine, bold: index < 2 }));
  if (process.env.HASTY_ASCII) {
    return [
      '  H A S T Y',
      '',
      '  terminal coding agent',
    ].map((line) => theme.brand(line)).join('\n');
  }
  return lines.join('\n');
}
