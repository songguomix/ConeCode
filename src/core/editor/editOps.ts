/**
 * Pure text operations for the editor (no DOM, no React) — auto-indent,
 * auto-close pairs, comment toggling, line moves/duplication/deletion and
 * "select next occurrence". Every function is a total function over
 * (content, cursor/selection) so it is unit-testable without a browser.
 */

export interface TextEdit {
  text: string;
  /** New collapsed cursor. */
  cursor: number;
  /** When set, the new selection end (selection-preserving ops). */
  selEnd?: number;
}

export const INDENT_UNIT = '  ';

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);
const PAIR_OF: Record<string, string> = { '(': ')', '[': ']', '{': '}', ')': '(', ']': '[', '}': '{' };
const QUOTES = new Set(['"', "'", '`']);
const isWordChar = (c: string | undefined) => !!c && /[A-Za-z0-9_$]/.test(c);

const PYTHON_LIKE = new Set(['python', 'py']);

function lineStartOf(content: string, pos: number): number {
  return content.lastIndexOf('\n', pos - 1) + 1;
}

function lineEndOf(content: string, pos: number): number {
  const i = content.indexOf('\n', pos);
  return i === -1 ? content.length : i;
}

/** 0-based line index containing pos. */
export function lineIndexOf(content: string, pos: number): number {
  let line = 0;
  for (let i = 0; i < pos; i++) if (content[i] === '\n') line++;
  return line;
}

/** Offset of the start of 0-based line `line`. */
export function offsetOfLine(content: string, line: number): number {
  let pos = 0;
  for (let l = 0; l < line; l++) {
    const i = content.indexOf('\n', pos);
    if (i === -1) return content.length;
    pos = i + 1;
  }
  return pos;
}

function leadingWS(s: string): string {
  return (s.match(/^[ \t]*/) || [''])[0];
}

// ---------------------------------------------------------------------------
// Enter: smart indent.
// ---------------------------------------------------------------------------

/**
 * What pressing Enter should do: carry the current indent, add one level
 * after an opener (or a Python-style `:`), and split a `{|}`-style pair so
 * the closer lands on its own dedented line.
 */
export function computeEnterEdit(content: string, cursor: number, lang = ''): TextEdit {
  const ls = lineStartOf(content, cursor);
  const lineBefore = content.slice(ls, cursor);
  const afterFull = content.slice(cursor);
  const lineAfter = afterFull.split('\n')[0];
  const indent = leadingWS(lineBefore);
  const trimmed = lineBefore.trimEnd();
  const lastBefore = trimmed[trimmed.length - 1];
  const firstAfter = lineAfter.trimStart()[0];

  const splitPair =
    !!lastBefore && !!firstAfter &&
    OPENERS.has(lastBefore) && PAIR_OF[lastBefore] === firstAfter;

  if (splitPair) {
    const text = content.slice(0, cursor) + '\n' + indent + INDENT_UNIT + '\n' + indent + afterFull;
    return { text, cursor: cursor + 1 + indent.length + INDENT_UNIT.length };
  }

  const opensBlock =
    /[{[(\[]\s*$/.test(lineBefore) ||
    (PYTHON_LIKE.has(lang) && /:\s*$/.test(lineBefore));
  const extra = opensBlock ? INDENT_UNIT : '';
  const text = content.slice(0, cursor) + '\n' + indent + extra + afterFull;
  return { text, cursor: cursor + 1 + indent.length + extra.length };
}

// ---------------------------------------------------------------------------
// Auto-close pairs, skip-over, pair-aware backspace, brace outdent.
// ---------------------------------------------------------------------------

export type PairResult = TextEdit | { skip: true } | null;

/**
 * Handle typing an opener/closer/quote. Returns the edit to apply
 * (caller preventDefaults and applies it), `{skip:true}` to hop over an
 * existing closer, or null to let the key insert normally.
 */
export function autoClose(content: string, cursor: number, ch: string): PairResult {
  if (CLOSERS.has(ch)) {
    if (content[cursor] === ch) return { skip: true };
    return null;
  }
  if (OPENERS.has(ch)) {
    const next = content[cursor];
    // Inside a word (`foo|bar`) a lone opener is what the user typed.
    if (isWordChar(next)) return null;
    const pair = PAIR_OF[ch];
    return {
      text: content.slice(0, cursor) + ch + pair + content.slice(cursor),
      cursor: cursor + 1,
    };
  }
  if (QUOTES.has(ch)) {
    const prev = content[cursor - 1];
    const next = content[cursor];
    if (next === ch) return { skip: true };
    // Apostrophe inside a word (`don't`) or a suffix (`foo'bar`) is literal.
    if (isWordChar(prev) || isWordChar(next)) return null;
    return {
      text: content.slice(0, cursor) + ch + ch + content.slice(cursor),
      cursor: cursor + 1,
    };
  }
  return null;
}

/** Backspace between an empty pair (`(|)`) deletes both halves. */
export function backspacePair(content: string, cursor: number): TextEdit | null {
  const prev = content[cursor - 1];
  const next = content[cursor];
  if (!prev || !next) return null;
  const paired = PAIR_OF[prev] === next || (QUOTES.has(prev) && prev === next);
  if (paired && (OPENERS.has(prev) || QUOTES.has(prev))) {
    return { text: content.slice(0, cursor - 1) + content.slice(cursor + 1), cursor: cursor - 1 };
  }
  return null;
}

/**
 * Typing `}` on a whitespace-only line dedents one level first, like VS Code.
 */
export function braceOutdent(content: string, cursor: number): TextEdit | null {
  const ls = lineStartOf(content, cursor);
  const before = content.slice(ls, cursor);
  if (!/^[ \t]+$/.test(before)) return null;
  let indent = before;
  if (indent.endsWith('\t')) indent = indent.slice(0, -1);
  else indent = indent.slice(0, Math.max(0, indent.length - INDENT_UNIT.length));
  return {
    text: content.slice(0, ls) + indent + '}' + content.slice(cursor),
    cursor: ls + indent.length + 1,
  };
}

// ---------------------------------------------------------------------------
// Comments.
// ---------------------------------------------------------------------------

export interface CommentToken {
  prefix: string;
  suffix?: string;
}

const HASH_LANGS = new Set(['python', 'bash', 'sh', 'shell', 'zsh', 'yaml', 'yml', 'toml', 'ruby', 'rb', 'makefile', 'dockerfile', 'ini', 'conf', 'r']);

/** Line-comment token for a highlighter language id. */
export function commentTokenFor(lang: string): CommentToken {
  const l = (lang || '').toLowerCase();
  if (HASH_LANGS.has(l)) return { prefix: '#' };
  if (l === 'sql') return { prefix: '--' };
  if (l === 'html' || l === 'xml' || l === 'vue') return { prefix: '<!--', suffix: '-->' };
  return { prefix: '//' };
}

function isCommented(line: string, token: CommentToken): boolean {
  const t = line.trim();
  if (!t) return false;
  if (!t.startsWith(token.prefix)) return false;
  if (token.suffix) return t.endsWith(token.suffix);
  return true;
}

/**
 * Toggle line comments over the lines overlapped by [start, end).
 * Blank lines are never (un)commented; selection tracks the text shift.
 */
export function toggleComment(content: string, start: number, end: number, lang: string): TextEdit {
  const token = commentTokenFor(lang);
  const lines = content.split('\n');
  const sLine = lineIndexOf(content, start);
  // A selection ending exactly at a line start excludes that line.
  const eLine = end > start && content[end - 1] === '\n' ? lineIndexOf(content, end - 1) : lineIndexOf(content, Math.max(start, end - 1));
  const allCommented = (() => {
    for (let i = sLine; i <= eLine; i++) {
      if (lines[i].trim() && !isCommented(lines[i], token)) return false;
    }
    return lines.slice(sLine, eLine + 1).some((l) => l.trim());
  })();

  const deltas: number[] = new Array(lines.length).fill(0);
  for (let i = sLine; i <= eLine; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = leadingWS(line);
    if (allCommented) {
      // Remove one token (plus a single following space) after the indent,
      // and a suffix when the language wraps lines.
      let rest = line.slice(indent.length + token.prefix.length);
      if (rest.startsWith(' ')) rest = rest.slice(1);
      let next = indent + rest;
      if (token.suffix && next.trimEnd().endsWith(token.suffix)) {
        const t = next.trimEnd();
        next = next.slice(0, next.length - (next.length - t.length) - token.suffix.length).replace(/[ \t]+$/, '');
      }
      deltas[i] = next.length - line.length;
      lines[i] = next;
    } else {
      const next = token.suffix
        ? `${indent}${token.prefix} ${line.slice(indent.length)} ${token.suffix}`
        : `${indent}${token.prefix} ${line.slice(indent.length)}`;
      deltas[i] = next.length - line.length;
      lines[i] = next;
    }
  }

  const shiftAt = (pos: number): number => {
    // Shift a caret by the deltas of lines strictly before it, plus a
    // partial shift when it sits after its own line's insertion point.
    const li = lineIndexOf(content, pos);
    let shift = 0;
    for (let i = sLine; i < li; i++) shift += deltas[i];
    if (li >= sLine && li <= eLine) {
      const lineStart = offsetOfLine(content, li);
      const insertCol = leadingWS(lines[li]).length - (deltas[li] > 0 ? deltas[li] : 0);
      if (pos - lineStart > insertCol) shift += deltas[li];
    }
    return shift;
  };

  return {
    text: lines.join('\n'),
    cursor: start + shiftAt(start),
    selEnd: end + shiftAt(end),
  };
}

// ---------------------------------------------------------------------------
// Line block ops.
// ---------------------------------------------------------------------------

/** Lines overlapped by [start, end), as a [first, last] line range. */
function blockRange(content: string, start: number, end: number): [number, number] {
  const s = lineIndexOf(content, start);
  const e = end > start && content[end - 1] === '\n'
    ? lineIndexOf(content, end - 1)
    : lineIndexOf(content, Math.max(start, end - 1));
  return [s, e];
}

/** Duplicate the block above (dir=-1) or below (dir=1); caret follows the copy. */
export function duplicateLines(content: string, start: number, end: number, dir: 1 | -1): TextEdit {
  const lines = content.split('\n');
  const [s, e] = blockRange(content, start, end);
  const block = lines.slice(s, e + 1).join('\n');
  const atTop = s === 0;
  let next: string;
  let cursor: number;
  let selEnd: number;
  if (dir === 1) {
    next = [...lines.slice(0, e + 1), block, ...lines.slice(e + 1)].join('\n');
    const copyStart = offsetOfLine(next, e + 1);
    cursor = copyStart + Math.min(start - offsetOfLine(content, s), block.length);
    selEnd = copyStart + Math.min(end - offsetOfLine(content, s), block.length);
  } else {
    if (atTop) {
      next = [block, ...lines].join('\n');
      cursor = Math.min(start, block.length);
      selEnd = Math.min(end, block.length);
    } else {
      next = [...lines.slice(0, s), block, ...lines.slice(s)].join('\n');
      const copyStart = offsetOfLine(next, s);
      cursor = copyStart + Math.min(start - offsetOfLine(content, s), block.length);
      selEnd = copyStart + Math.min(end - offsetOfLine(content, s), block.length);
    }
  }
  return { text: next, cursor, selEnd };
}

/** Move the block one line up/down; no-op at the edges. */
export function moveLines(content: string, start: number, end: number, dir: 1 | -1): TextEdit {
  const lines = content.split('\n');
  const [s, e] = blockRange(content, start, end);
  if (dir === -1 && s === 0) return { text: content, cursor: start, selEnd: end };
  if (dir === 1 && e === lines.length - 1) return { text: content, cursor: start, selEnd: end };
  const next = [...lines];
  if (dir === -1) {
    const above = next.splice(s - 1, 1)[0];
    next.splice(e, 0, above);
  } else {
    const below = next.splice(e + 1, 1)[0];
    next.splice(s, 0, below);
  }
  const text = next.join('\n');
  const ns = s + dir;
  const cursor = offsetOfLine(text, ns) + Math.min(start - offsetOfLine(content, s), next[ns].length);
  const selEnd = offsetOfLine(text, ns + (e - s)) + Math.min(end - offsetOfLine(content, s), next[ns + (e - s)].length);
  return { text, cursor, selEnd };
}

/** Delete whole overlapped lines; caret lands at the block start. */
export function deleteLines(content: string, start: number, end: number): TextEdit {
  const lines = content.split('\n');
  const [s, e] = blockRange(content, start, end);
  const next = [...lines.slice(0, s), ...lines.slice(e + 1)];
  // Removing the file's only line leaves an empty file, not a ghost newline.
  const text = next.join('\n');
  return { text, cursor: Math.min(offsetOfLine(content, s), text.length) };
}

// ---------------------------------------------------------------------------
// Word select-next (Ctrl+D).
// ---------------------------------------------------------------------------

const WORD_RE = /[A-Za-z0-9_$]/;

/** Identifier bounds around pos, or null when pos is not on a word. */
export function wordAt(content: string, pos: number): { start: number; end: number; word: string } | null {
  const at = (i: number) => (i >= 0 && i < content.length ? content[i] : '');
  let s = pos;
  let e = pos;
  if (!WORD_RE.test(at(pos)) && !WORD_RE.test(at(pos - 1))) return null;
  while (s > 0 && WORD_RE.test(at(s - 1))) s--;
  while (e < content.length && WORD_RE.test(at(e))) e++;
  if (s === e) return null;
  return { start: s, end: e, word: content.slice(s, e) };
}

/**
 * Next occurrence of the selection (wrapping); with a collapsed caret it
 * selects the word under it first. Null when there is no other occurrence.
 */
export function selectNextOccurrence(content: string, selStart: number, selEnd: number): { start: number; end: number } | null {
  let needle: string;
  let from: number;
  if (selStart === selEnd) {
    const w = wordAt(content, selStart);
    if (!w) return null;
    return { start: w.start, end: w.end };
  }
  needle = content.slice(selStart, selEnd);
  from = selEnd;
  if (!needle) return null;
  let idx = content.indexOf(needle, from);
  if (idx === -1) idx = content.indexOf(needle, 0);
  if (idx === -1 || idx === selStart) return null;
  return { start: idx, end: idx + needle.length };
}
