// Minimal ANSI escape-code parser: turns a terminal output string into styled
// text segments the renderer can paint as colored <span>s. Handles SGR color
// codes (16-color, 256-color, truecolor, bold/italic/underline) and strips
// non-color control sequences (cursor moves, screen/line erase, OSC titles).

export interface AnsiSegment {
  text: string;
  style: React.CSSProperties;
}

// Standard xterm palette for the 16 base colors (theme-independent, like a real
// terminal). Index 0–7 normal, 8–15 bright.
const BASE16 = [
  '#1a1a1a', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#cccccc',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];

// Resolve an xterm 256-color index to a hex string.
function color256(n: number): string {
  if (n < 16) return BASE16[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const c = (x: number) => (x === 0 ? 0 : x * 40 + 55);
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

interface SgrState {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
}

function applySgr(state: SgrState, params: number[]): SgrState {
  const s = { ...state };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) { Object.keys(s).forEach((k) => delete (s as any)[k]); }
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 22) { s.bold = false; s.dim = false; }
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p === 39) s.fg = undefined;
    else if (p === 49) s.bg = undefined;
    else if (p >= 30 && p <= 37) s.fg = BASE16[p - 30];
    else if (p >= 90 && p <= 97) s.fg = BASE16[p - 90 + 8];
    else if (p >= 40 && p <= 47) s.bg = BASE16[p - 40];
    else if (p >= 100 && p <= 107) s.bg = BASE16[p - 100 + 8];
    else if (p === 38 || p === 48) {
      const target = p === 38 ? 'fg' : 'bg';
      if (params[i + 1] === 5) { (s as any)[target] = color256(params[i + 2]); i += 2; }
      else if (params[i + 1] === 2) { (s as any)[target] = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`; i += 4; }
    }
  }
  return s;
}

function toStyle(s: SgrState): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (s.fg) style.color = s.fg;
  if (s.bg) style.background = s.bg;
  if (s.bold) style.fontWeight = 700;
  if (s.italic) style.fontStyle = 'italic';
  if (s.underline) style.textDecoration = 'underline';
  if (s.dim) style.opacity = 0.6;
  return style;
}

export function parseAnsi(input: string): AnsiSegment[] {
  // Normalize CRLF and drop bare carriage returns (progress-bar redraws).
  const text = input.replace(/\r\n/g, '\n').replace(/\r/g, '');
  const segments: AnsiSegment[] = [];
  let state: SgrState = {};
  let buf = '';
  let i = 0;

  const flush = () => {
    if (buf) { segments.push({ text: buf, style: toStyle(state) }); buf = ''; }
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === '\x1b') {
      const next = text[i + 1];
      if (next === '[') {
        // CSI sequence: ESC [ params letter
        let j = i + 2;
        while (j < text.length && !/[A-Za-z]/.test(text[j])) j++;
        const letter = text[j];
        const body = text.slice(i + 2, j);
        if (letter === 'm') {
          flush();
          const params = body.split(';').map((x) => (x === '' ? 0 : parseInt(x, 10)));
          state = applySgr(state, params);
        }
        // any other CSI (cursor move, erase, etc.) is dropped
        i = j + 1;
        continue;
      } else if (next === ']') {
        // OSC sequence: ESC ] ... (BEL | ESC \)
        let j = i + 2;
        while (j < text.length && text[j] !== '\x07' && !(text[j] === '\x1b' && text[j + 1] === '\\')) j++;
        i = text[j] === '\x07' ? j + 1 : j + 2;
        continue;
      } else {
        // lone ESC or other — skip the ESC
        i += 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return segments;
}
