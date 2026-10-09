/**
 * Dependency-free completion engine for the editor: keywords and snippets per
 * language family, identifiers harvested from the open document, and relative
 * file paths inside import strings. Everything is a pure function over text so
 * the ranking and triggers are unit-testable; the panel only positions the
 * popup and applies the chosen item.
 */

export type CompletionKind = 'snippet' | 'keyword' | 'path' | 'word' | 'property';
export type CompletionMode = 'word' | 'property' | 'path';

export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  /** Right-side hint (e.g. snippet expansion preview, "keyword"). */
  detail?: string;
  /** Text to insert. A single `|` marks where the caret lands. */
  insert: string;
  /** Keep the popup open after accepting (directory descent). */
  keepOpen?: boolean;
}

export interface FileNode {
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

const KIND_RANK: Record<CompletionKind, number> = {
  snippet: 0,
  keyword: 1,
  path: 2,
  property: 3,
  word: 4,
};

// `|` is the caret marker inside a snippet body.
export function splitInsert(insert: string): { text: string; cursorOffset: number } {
  const at = insert.indexOf('|');
  if (at === -1) return { text: insert, cursorOffset: insert.length };
  return { text: insert.slice(0, at) + insert.slice(at + 1), cursorOffset: at };
}

interface SnippetDef {
  label: string;
  detail: string;
  body: string;
}

const JS_SNIPPETS: SnippetDef[] = [
  { label: 'for', detail: 'for loop', body: 'for (let i = 0; i < |; i++) {\n  \n}' },
  { label: 'forof', detail: 'for…of', body: 'for (const | of ) {\n  \n}' },
  { label: 'if', detail: 'if statement', body: 'if (|) {\n  \n}' },
  { label: 'ife', detail: 'if…else', body: 'if (|) {\n  \n} else {\n  \n}' },
  { label: 'fn', detail: 'function', body: 'function |() {\n  \n}' },
  { label: 'arrow', detail: 'arrow function', body: 'const | = () => {\n  \n};' },
  { label: 'try', detail: 'try…catch', body: 'try {\n  |\n} catch (e) {\n  \n}' },
  { label: 'clg', detail: 'console.log()', body: 'console.log(|);' },
  { label: 'cls', detail: 'class', body: 'class | {\n  constructor() {\n    \n  }\n}' },
  { label: 'imp', detail: 'import', body: "import { | } from '';" },
  { label: 'exp', detail: 'export', body: 'export |;' },
  { label: 'while', detail: 'while loop', body: 'while (|) {\n  \n}' },
  { label: 'switch', detail: 'switch', body: 'switch (|) {\n  case :\n    break;\n  default:\n}' },
  { label: 'af', detail: 'async function', body: 'async function |() {\n  \n}' },
];

const PY_SNIPPETS: SnippetDef[] = [
  { label: 'def', detail: 'function', body: 'def |():\n    ' },
  { label: 'if', detail: 'if statement', body: 'if |:\n    ' },
  { label: 'ife', detail: 'if…else', body: 'if |:\n    \nelse:\n    ' },
  { label: 'for', detail: 'for loop', body: 'for | in :\n    ' },
  { label: 'while', detail: 'while loop', body: 'while |:\n    ' },
  { label: 'try', detail: 'try…except', body: 'try:\n    |\nexcept Exception:\n    ' },
  { label: 'cls', detail: 'class', body: 'class |:\n    def __init__(self):\n        ' },
  { label: 'with', detail: 'with block', body: 'with | as :\n    ' },
  { label: 'imp', detail: 'import', body: 'import |' },
  { label: 'from', detail: 'from…import', body: 'from | import ' },
  { label: 'print', detail: 'print()', body: 'print(|)' },
  { label: 'main', detail: '__main__ guard', body: "if __name__ == '__main__':\n    |" },
];

const HTML_SNIPPETS: SnippetDef[] = [
  { label: 'div', detail: '<div>', body: '<div>|</div>' },
  { label: 'span', detail: '<span>', body: '<span>|</span>' },
  { label: 'a', detail: '<a>', body: '<a href="|"></a>' },
  { label: 'img', detail: '<img>', body: '<img src="|" alt="" />' },
  { label: 'input', detail: '<input>', body: '<input type="|" />' },
  { label: 'btn', detail: '<button>', body: '<button>|</button>' },
  { label: 'ul', detail: '<ul>', body: '<ul>\n  <li>|</li>\n</ul>' },
  { label: 'form', detail: '<form>', body: '<form>\n  |\n</form>' },
];

const CSS_SNIPPETS: SnippetDef[] = [
  { label: 'flex', detail: 'flexbox', body: 'display: flex;\njustify-content: |;\nalign-items: ;' },
  { label: 'grid', detail: 'grid', body: 'display: grid;\ngrid-template-columns: |;' },
  { label: 'media', detail: '@media', body: '@media (|) {\n  \n}' },
];

const KEYWORDS: Record<string, string[]> = {
  js: ('const let var function return if else for while import from export default class extends new await async ' +
    'try catch finally throw typeof instanceof switch case break continue delete in of do void this super ' +
    'interface type enum implements static get set readonly abstract as satisfies keyof infer never unknown').split(' '),
  py: ('def return if elif else for while import from as class try except finally raise with lambda pass ' +
    'None True False and or not in is global nonlocal assert del yield async await').split(' '),
  html: 'div span a p h1 h2 h3 ul ol li table tr td th form input button select option textarea img header footer main section nav article aside'.split(' '),
  css: ('display position flex grid margin padding width height color background border font-size font-weight ' +
    'justify-content align-items gap transition transform animation opacity z-index overflow cursor').split(' '),
  json: ['true', 'false', 'null'],
  sh: ('if then else elif fi for while do done case esac function in echo export local return exit set shift trap').split(' '),
  go: ('func return if else for range import package var const type struct interface map chan go defer select case ' +
    'break continue fallthrough switch default nil true false').split(' '),
  rust: ('fn return if else for while loop in use mod pub struct enum impl trait match let mut const static ref ' +
    'move where true false self Self super crate extern unsafe async await').split(' '),
  java: ('public private protected class interface extends implements static final void int long double boolean ' +
    'return if else for while new try catch finally throw import package this super').split(' '),
};

function familyOf(lang: string): string {
  const l = (lang || '').toLowerCase();
  if (['typescript', 'javascript', 'ts', 'js'].includes(l)) return 'js';
  if (['python', 'py'].includes(l)) return 'py';
  if (['html', 'xml', 'vue'].includes(l)) return 'html';
  if (l === 'css') return 'css';
  if (l === 'json') return 'json';
  if (['bash', 'sh', 'shell', 'zsh'].includes(l)) return 'sh';
  if (l === 'go') return 'go';
  if (l === 'rust') return 'rust';
  if (l === 'java' || l === 'csharp' || l === 'c' || l === 'cpp' || l === 'php' || l === 'kotlin' || l === 'swift') return 'java';
  return '';
}

export function snippetsFor(lang: string): CompletionItem[] {
  const f = familyOf(lang);
  const defs = f === 'js' ? JS_SNIPPETS : f === 'py' ? PY_SNIPPETS : f === 'html' ? HTML_SNIPPETS : f === 'css' ? CSS_SNIPPETS : [];
  return defs.map((d) => ({ label: d.label, kind: 'snippet' as const, detail: d.detail, insert: d.body }));
}

export function keywordsFor(lang: string): CompletionItem[] {
  const words = KEYWORDS[familyOf(lang)] || [];
  return words.map((w) => ({ label: w, kind: 'keyword' as const, insert: w }));
}

/**
 * Harvest identifiers from the document for word completion: frequency-ranked,
 * minus the word currently being typed, capped so huge files stay cheap.
 */
export function wordsIn(doc: string, exclude = '', cap = 40): CompletionItem[] {
  const freq = new Map<string, number>();
  const hay = doc.length > 100_000 ? doc.slice(0, 100_000) : doc;
  const re = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(hay))) {
    const w = m[0];
    if (w === exclude) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([w, n]) => ({ label: w, kind: 'word' as const, detail: n > 1 ? `×${n}` : undefined, insert: w }));
}

/** Flatten a file tree to paths relative to root (dirs keep a trailing `/`). */
export function flattenPaths(nodes: FileNode[] | undefined, root: string): string[] {
  const out: string[] = [];
  const walk = (items: FileNode[] | undefined) => {
    for (const it of items || []) {
      const rel = it.path === root ? '' : it.path.startsWith(root + '/') ? it.path.slice(root.length + 1) : null;
      if (rel === null) continue;
      if (!rel) { walk(it.children); continue; }
      out.push(it.isDirectory ? rel + '/' : rel);
      walk(it.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Sibling + child entries of the current file's directory matching the path
 * segment being typed (`./`, `../` always offered). Directories keep the popup
 * open so the user can descend into them.
 */
export function pathCompletions(allPaths: string[], currentDir: string, segment: string): CompletionItem[] {
  const prefix = currentDir ? currentDir + '/' : '';
  const seen = new Set<string>();
  const out: CompletionItem[] = [];
  const push = (label: string, rest: string, isDir: boolean) => {
    if (seen.has(label)) return;
    seen.add(label);
    out.push({
      label,
      kind: 'path',
      detail: isDir ? 'dir' : undefined,
      insert: rest,
      keepOpen: isDir,
    });
  };
  const segLower = segment.toLowerCase();
  for (const p of allPaths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (!rest || rest.startsWith('.')) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      if (rest.toLowerCase().startsWith(segLower) && rest !== segment) push(rest, rest, false);
    } else {
      const dir = rest.slice(0, slash + 1);
      if (dir.toLowerCase().startsWith(segLower) && dir !== segment) push(dir, dir, true);
    }
  }
  if (segment === '' || './'.startsWith(segment)) push('./', './', true);
  push('../', '../', true);
  return out.slice(0, 30);
}

export interface SuggestContext {
  mode: CompletionMode;
  /** The already-typed fragment to replace. */
  prefix: string;
  /** Offset where `prefix` starts (replacement origin). */
  replaceStart: number;
  /** In path mode, the typed path segment after the last `/`. */
  segment?: string;
  /** In path mode, whether the caret is inside a string literal. */
  inString?: boolean;
}

const WORD_TAIL = /[A-Za-z0-9_$]+$/;
const PATH_TAIL = /['"`]?([A-Za-z0-9_@$~.\-+/]*)$/;

/**
 * What, if anything, should be completed at the caret. Word fragments offer
 * keywords/snippets/identifiers, a bare `.` offers document words as members,
 * and a fragment inside a string (or right after `/`) offers file paths.
 */
export function suggestContext(content: string, cursor: number): SuggestContext | null {
  const ls = content.lastIndexOf('\n', cursor - 1) + 1;
  const lineBefore = content.slice(ls, cursor);
  const stringMatch = /(['"`])[^'"`\n]*$/.exec(lineBefore);
  const inString = !!stringMatch;
  if (inString) {
    const m = PATH_TAIL.exec(lineBefore);
    // A string that is only an opening quote (or quote + dots/slashes) still
    // wants paths — that is exactly when imports get typed.
    const segment = m ? m[1].split('/').pop() ?? '' : '';
    const pathy = m ? /[/.]/.test(m[1]) || m[1] === '' : false;
    if (pathy || segment.length >= 1) {
      return {
        mode: 'path',
        prefix: segment,
        replaceStart: cursor - segment.length,
        segment,
        inString: true,
      };
    }
    return null;
  }
  const w = WORD_TAIL.exec(lineBefore);
  if (w) {
    return { mode: 'word', prefix: w[0], replaceStart: cursor - w[0].length };
  }
  if (lineBefore.endsWith('.')) {
    const before = lineBefore.slice(0, -1);
    if (/[A-Za-z0-9_$)>\]]$/.test(before)) {
      return { mode: 'property', prefix: '', replaceStart: cursor };
    }
  }
  return null;
}

export interface SuggestOptions {
  lang: string;
  doc: string;
  files?: string[];
  currentDir?: string;
}

/** Full candidate list for a context (unfiltered in property mode). */
export function candidates(ctx: SuggestContext, opts: SuggestOptions): CompletionItem[] {
  if (ctx.mode === 'path') {
    return pathCompletions(opts.files || [], opts.currentDir || '', ctx.segment || '');
  }
  const words = wordsIn(opts.doc, ctx.prefix);
  if (ctx.mode === 'property') {
    return words.map((w) => ({ ...w, kind: 'property' as const }));
  }
  return [...snippetsFor(opts.lang), ...keywordsFor(opts.lang), ...words];
}

/** Subsequence fuzzy match; returns a score or null when it doesn't match. */
function fuzzyScore(label: string, prefix: string): number | null {
  const l = label.toLowerCase();
  const p = prefix.toLowerCase();
  if (!p) return 0;
  if (l === p) return 1000;
  if (l.startsWith(p)) return 500 + Math.max(0, 40 - l.length);
  let li = 0;
  let gaps = 0;
  for (let pi = 0; pi < p.length; pi++) {
    const at = l.indexOf(p[pi], li);
    if (at === -1) return null;
    gaps += at - li;
    li = at + 1;
  }
  // Late, gappy matches rank below compact ones.
  return Math.max(1, 200 - gaps * 8 - l.length);
}

/** Filter by the typed prefix and rank: exact > prefix > fuzzy, snippets first. */
export function filterCompletions(items: CompletionItem[], prefix: string, cap = 50): CompletionItem[] {
  const scored: { item: CompletionItem; score: number }[] = [];
  for (const item of items) {
    const s = fuzzyScore(item.label, prefix);
    if (s === null) continue;
    scored.push({ item, score: s * 10 - KIND_RANK[item.kind] });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, cap).map((s) => s.item);
}
