/**
 * Editor diagnostics without a language server: bracket matching that
 * understands strings and comments, JSON syntax errors mapped to line/col,
 * trailing-whitespace warnings — plus the safe automatic fixes ("Fix all").
 * Pure functions over text; the panel only renders and applies.
 */

export interface Diagnostic {
  /** 1-based line. */
  line: number;
  /** 1-based start column (monospace, tabs count as TAB_WIDTH). */
  col: number;
  /** 1-based end column (exclusive). */
  endCol: number;
  severity: 'error' | 'warning';
  message: string;
}

export const TAB_WIDTH = 2;
export const MAX_DIAG_LINES = 10_000;
export const MAX_DIAG_BYTES = 500_000;

const HASH_LANGS = new Set(['python', 'bash', 'sh', 'shell', 'zsh', 'yaml', 'yml', 'toml', 'ruby', 'rb', 'makefile', 'dockerfile', 'ini', 'conf', 'r']);
const SLASH_LANGS = new Set([
  'typescript', 'javascript', 'ts', 'js', 'json', 'jsonc', 'json5', 'css', 'java', 'c', 'cpp', 'h', 'hpp',
  'csharp', 'cs', 'go', 'rust', 'kotlin', 'swift', 'php',
]);
const HTML_LANGS = new Set(['html', 'xml', 'vue', 'svg']);

function lineCommentsFor(lang: string): string[] {
  const l = (lang || '').toLowerCase();
  if (HASH_LANGS.has(l)) return ['#'];
  if (l === 'sql') return ['--'];
  if (HTML_LANGS.has(l)) return [];
  if (SLASH_LANGS.has(l)) return ['//'];
  return [];
}

function blockCommentsFor(lang: string): [string, string][] {
  const l = (lang || '').toLowerCase();
  const out: [string, string][] = [];
  if (SLASH_LANGS.has(l)) out.push(['/*', '*/']);
  if (HTML_LANGS.has(l)) out.push(['<!--', '-->']);
  return out;
}

const TICK = String.fromCharCode(96);

/**
 * If offset `i` opens a string/comment, return the offset just past it;
 * otherwise -1. The single shared skipper, so the bracket scanner and the
 * matcher can never disagree about what is code.
 */
export function skipStringOrComment(content: string, lang: string, i: number): number {
  const n = content.length;
  const c = content[i];
  const c2 = content[i + 1];
  if (c === '"' || c === "'" || c === TICK) {
    let j = i + 1;
    while (j < n) {
      if (content[j] === '\\') { j += 2; continue; }
      if (content[j] === c) return j + 1;
      // A newline ends ' and " (but not template literals).
      if (content[j] === '\n' && c !== TICK) return j;
      j++;
    }
    return n;
  }
  for (const token of lineCommentsFor(lang)) {
    if (token && content.startsWith(token, i)) {
      let j = content.indexOf('\n', i);
      return j === -1 ? n : j;
    }
  }
  for (const [open, close] of blockCommentsFor(lang)) {
    if (open && content.startsWith(open, i)) {
      const j = content.indexOf(close, i + open.length);
      return j === -1 ? n : j + close.length;
    }
  }
  return -1;
}

const MATCH: Record<string, string> = { '(': ')', '[': ']', '{': '}', ')': '(', ']': '[', '}': '{' };
const isOpen = (c: string) => c === '(' || c === '[' || c === '{';
const isBracket = (c: string) => isOpen(c) || c === ')' || c === ']' || c === '}';

/**
 * Find the bracket matching the one at `pos` (either end). Null when `pos`
 * is not on a bracket or it has no match. Strings/comments never count.
 */
export function matchBracket(content: string, lang: string, pos: number): number | null {
  const start = content[pos];
  if (!start || !isBracket(start)) return null;
  const forward = isOpen(start);
  const target = MATCH[start];
  let depth = 0;
  if (forward) {
    let i = pos;
    while (i < content.length) {
      const skip = skipStringOrComment(content, lang, i);
      if (skip !== -1) { i = skip; continue; }
      const c = content[i];
      if (c === start) depth++;
      else if (c === target) {
        depth--;
        if (depth === 0) return i;
      }
      i++;
    }
  } else {
    let i = pos;
    while (i >= 0) {
      // Walking backwards: a closer ends whatever string/comment contains it,
      // so rewind to the token start by scanning forward from the line start.
      const ls = content.lastIndexOf('\n', i - 1) + 1;
      let j = ls;
      let inCode = true;
      let k = ls;
      while (k <= i) {
        const skip = skipStringOrComment(content, lang, k);
        if (skip !== -1 && skip > k) {
          if (i < skip) { inCode = false; break; }
          k = skip;
        } else {
          if (k === i) break;
          k++;
        }
        void j;
      }
      if (!inCode) { i = ls - 1; continue; }
      const c = content[i];
      if (c === start) depth++;
      else if (c === target) {
        depth--;
        if (depth === 0) return i;
      }
      i--;
    }
  }
  return null;
}

export interface BracketStackEntry {
  ch: string;
  line: number;
  col: number;
  offset: number;
}

export interface BracketScan {
  errors: Diagnostic[];
  /** Still-open brackets at EOF (innermost last) — feeds the auto-closer. */
  unclosed: BracketStackEntry[];
}

/** Offset → 1-based (line, col) with tabs expanded to TAB_WIDTH. */
export function offsetToLineCol(content: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') { line++; col = 1; }
    else col += content[i] === '\t' ? TAB_WIDTH : 1;
  }
  return { line, col };
}

/** Full bracket pass: mismatches, unexpected closers, and what is left open. */
export function scanBrackets(content: string, lang: string): BracketScan {
  const errors: Diagnostic[] = [];
  const stack: BracketStackEntry[] = [];
  let i = 0;
  while (i < content.length && errors.length < 50) {
    const skip = skipStringOrComment(content, lang, i);
    if (skip !== -1) { i = Math.max(skip, i + 1); continue; }
    const c = content[i];
    if (isOpen(c)) {
      const { line, col } = offsetToLineCol(content, i);
      stack.push({ ch: c, line, col, offset: i });
    } else if (c === ')' || c === ']' || c === '}') {
      const top = stack[stack.length - 1];
      const { line, col } = offsetToLineCol(content, i);
      if (!top) {
        errors.push({ line, col, endCol: col + 1, severity: 'error', message: `Unexpected '${c}' — nothing to close` });
      } else if (MATCH[top.ch] !== c) {
        errors.push({ line, col, endCol: col + 1, severity: 'error', message: `Mismatched '${c}' — opened '${top.ch}' on line ${top.line}, expected '${MATCH[top.ch]}'` });
        stack.pop();
      } else {
        stack.pop();
      }
    }
    i++;
  }
  const unclosed = [...stack];
  for (let s = stack.length - 1; s >= 0 && errors.length < 50; s--) {
    const top = stack[s];
    errors.push({
      line: top.line, col: top.col, endCol: top.col + 1,
      severity: 'error', message: `Unclosed '${top.ch}' — missing '${MATCH[top.ch]}'`,
    });
  }
  return { errors, unclosed };
}

function jsonError(content: string): Diagnostic | null {
  try {
    JSON.parse(content);
    return null;
  } catch (e: any) {
    const msg = String(e?.message || 'Invalid JSON');
    const at = /position (\d+)/.exec(msg)?.[1];
    const offset = at !== undefined ? Math.min(parseInt(at, 10), content.length) : content.length;
    const { line, col } = offsetToLineCol(content, offset);
    const clean = msg.replace(/\s+at position \d+.*$/, '').replace(/^JSON\.parse:\s*/, '');
    return { line, col, endCol: col + 1, severity: 'error', message: `JSON: ${clean}` };
  }
}

function trailingWhitespace(content: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length && out.length < 100; i++) {
    const m = /[ \t]+$/.exec(lines[i]);
    if (m) {
      const col = lines[i].length - m[0].length + 1;
      out.push({ line: i + 1, col, endCol: lines[i].length + 1, severity: 'warning', message: 'Trailing whitespace' });
    }
  }
  return out;
}

/**
 * All diagnostics for a document, errors before warnings. Skipped entirely
 * for huge files where a scan would only add typing latency.
 */
export function diagnose(content: string, lang: string): Diagnostic[] {
  if (content.length > MAX_DIAG_BYTES || content.split('\n').length > MAX_DIAG_LINES) return [];
  const l = (lang || '').toLowerCase();
  if (l === 'json') {
    const err = jsonError(content);
    return [...(err ? [err] : []), ...trailingWhitespace(content)];
  }
  // jsonc/json5 tolerate comments — only the bracket pass applies.
  const { errors } = scanBrackets(content, lang);
  return [...errors, ...trailingWhitespace(content)];
}

export interface QuickFixResult {
  text: string;
  /** Human-readable counts, e.g. ["12 whitespace", "2 brackets"]. */
  applied: string[];
}

/**
 * The safe automatic fixes: strip trailing whitespace everywhere and append
 * closers for brackets still open at EOF. Never touches anything else, so it
 * can run as "Fix all" without review.
 */
export function applyQuickFixes(content: string, lang: string): QuickFixResult {
  const applied: string[] = [];
  const lines = content.split('\n');
  let trimmed = 0;
  const stripped = lines.map((l) => {
    const next = l.replace(/[ \t]+$/, '');
    if (next !== l) trimmed++;
    return next;
  });
  let text = stripped.join('\n');
  if (trimmed > 0) applied.push(`${trimmed} whitespace`);
  const { unclosed } = scanBrackets(text, lang);
  if (unclosed.length > 0) {
    const closers = unclosed.slice().reverse().map((u) => MATCH[u.ch]).join('');
    text += (text.endsWith('\n') ? '' : '\n') + closers;
    applied.push(`${unclosed.length} bracket${unclosed.length === 1 ? '' : 's'}`);
  }
  return { text, applied };
}
