// Pure CommonMark-subset parser for chat messages. No React, no DOM — the UI
// renders the AST in MessageContent.tsx, and these shapes are unit-tested.
//
// Covered: paragraphs, ATX headings (1–6), thematic breaks, fenced code (owned
// by the outer segment splitter — not here), nested bullet/ordered lists with
// task items, multi-line blockquotes, and GFM tables.

export type MdAlign = 'left' | 'center' | 'right' | null;

export interface MdListItem {
  /** Nesting depth: 0 = top level. */
  depth: number;
  text: string;
  /** Task checkbox: true/false when `- [x]` / `- [ ]`, else null. */
  checked: boolean | null;
  ordered: boolean;
  /** 1-based number for ordered items (display). */
  ordinal?: number;
}

export type MdBlock =
  | { type: 'p'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'hr' }
  | { type: 'quote'; text: string }
  | { type: 'list'; items: MdListItem[] }
  | { type: 'table'; align: MdAlign[]; header: string[]; rows: string[][] };

function isThematicBreak(line: string): boolean {
  const t = line.trim();
  return /^(-{3,}|\*{3,}|_{3,})$/.test(t);
}

function headingMatch(line: string): { level: number; text: string } | null {
  const m = line.match(/^(#{1,6})\s+(.*)$/);
  if (!m) return null;
  return { level: m[1].length, text: m[2].replace(/\s+#+\s*$/, '').trim() };
}

function listMatch(line: string): {
  depth: number;
  ordered: boolean;
  ordinal?: number;
  checked: boolean | null;
  text: string;
} | null {
  // 2 spaces per indent level is the common chat convention; tabs count as 4.
  const expanded = line.replace(/\t/g, '    ');
  const m = expanded.match(/^(\s*)(?:([-*+])\s+|(\d+)[.)]\s+)(.*)$/);
  if (!m) return null;
  const indent = m[1].length;
  const bullet = m[2];
  const ordRaw = m[3];
  const ordered = !bullet;
  let body = m[4];
  let checked: boolean | null = null;
  const task = body.match(/^\[([ xX])\]\s+(.*)$/);
  if (task) {
    checked = task[1].toLowerCase() === 'x';
    body = task[2];
  }
  return {
    depth: Math.floor(indent / 2),
    ordered,
    ordinal: ordered && ordRaw ? parseInt(ordRaw, 10) : undefined,
    checked,
    text: body,
  };
}

function tableSplit(row: string): string[] {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length) {
      cur += s[i + 1];
      i += 2;
      continue;
    }
    if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += s[i];
    i++;
  }
  cells.push(cur.trim());
  return cells;
}

function tableAlign(spec: string): MdAlign[] {
  return tableSplit(spec).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

function isTableDivider(line: string): boolean {
  const t = line.trim();
  if (!t.includes('-')) return false;
  return /^\|?[\s:|-]+\|?$/.test(t) && /-/.test(t);
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.includes('|') && !isTableDivider(t);
}

/**
 * Parse a markdown *prose* block (fenced code already stripped by the caller).
 */
export function parseMarkdownBlocks(text: string): MdBlock[] {
  const lines = text.split('\n');
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: MdListItem[] = [];
  let quote: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    const joined = para.join('\n').trim();
    if (joined) blocks.push({ type: 'p', text: joined });
    para = [];
  };
  const flushList = () => {
    if (!list.length) return;
    blocks.push({ type: 'list', items: list });
    list = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    blocks.push({ type: 'quote', text: quote.join('\n') });
    quote = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // Blank line: block boundary (unless we are inside a lazy continuation).
    if (line.trim() === '') {
      flushAll();
      i++;
      continue;
    }

    // Table: header + divider + rows
    if (isTableRow(line) && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushAll();
      const header = tableSplit(line);
      const align = tableAlign(lines[i + 1]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(tableSplit(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', align, header, rows });
      continue;
    }

    const heading = headingMatch(line);
    if (heading) {
      flushAll();
      blocks.push({ type: 'heading', level: heading.level, text: heading.text });
      i++;
      continue;
    }

    if (isThematicBreak(line)) {
      flushAll();
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    const quoteLine = line.match(/^>\s?(.*)$/);
    if (quoteLine) {
      flushPara();
      flushList();
      quote.push(quoteLine[1]);
      i++;
      continue;
    }
    // Lazy continuation of a blockquote (plain line right after a quote line).
    if (quote.length && !listMatch(line) && !headingMatch(line)) {
      quote.push(line);
      i++;
      continue;
    }

    const item = listMatch(line);
    if (item) {
      flushPara();
      flushQuote();
      list.push({
        depth: item.depth,
        text: item.text,
        checked: item.checked,
        ordered: item.ordered,
        ordinal: item.ordinal,
      });
      i++;
      continue;
    }

    // Paragraph text (flush list/quote first — a new paragraph starts).
    flushList();
    flushQuote();
    para.push(line);
    i++;
  }
  flushAll();
  return blocks;
}

// ---------------------------------------------------------------------------
// Inline tokens (rendered by MessageContent). Kept as a split helper so tests
// can pin the regex without mounting React.
// ---------------------------------------------------------------------------

export const INLINE_PATTERN = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)\s]+\))/g;

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string }
  | { type: 'del'; text: string }
  | { type: 'link'; text: string; href: string };

/** Split one line/paragraph into inline tokens. */
export function parseInline(text: string): MdInline[] {
  const parts = text.split(INLINE_PATTERN);
  const out: MdInline[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
      out.push({ type: 'code', text: part.slice(1, -1) });
      continue;
    }
    if (part.length >= 4 && part.startsWith('**') && part.endsWith('**')) {
      out.push({ type: 'strong', text: part.slice(2, -2) });
      continue;
    }
    if (part.length >= 4 && part.startsWith('__') && part.endsWith('__')) {
      out.push({ type: 'strong', text: part.slice(2, -2) });
      continue;
    }
    if (part.length >= 4 && part.startsWith('~~') && part.endsWith('~~')) {
      out.push({ type: 'del', text: part.slice(2, -2) });
      continue;
    }
    if (part.length >= 2 && part.startsWith('*') && part.endsWith('*')) {
      out.push({ type: 'em', text: part.slice(1, -1) });
      continue;
    }
    if (part.length >= 2 && part.startsWith('_') && part.endsWith('_')) {
      out.push({ type: 'em', text: part.slice(1, -1) });
      continue;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (link) {
      // Unsafe schemes stay plain text — never become clickable tokens.
      if (isSafeHttpUrl(link[2])) {
        out.push({ type: 'link', text: link[1], href: link[2] });
      } else {
        out.push({ type: 'text', text: link[1] });
      }
      continue;
    }
    out.push({ type: 'text', text: part });
  }
  return out;
}

/** Only http(s) links become anchors — everything else is plain text. */
export function isSafeHttpUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}
