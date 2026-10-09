import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { FiSave, FiSearch, FiX, FiChevronUp, FiChevronDown } from 'react-icons/fi';
import { useWorkspaceStore, useLanguageStore, useUIStore, useAiHighlightsStore } from '../../stores';
import { highlightCode } from './highlight';
import {
  computeEnterEdit, autoClose, backspacePair, braceOutdent,
  toggleComment, duplicateLines, moveLines, deleteLines,
  selectNextOccurrence, type TextEdit,
} from '../../core/editor/editOps';
import {
  suggestContext, candidates, filterCompletions, splitInsert,
  flattenPaths, type CompletionItem,
} from '../../core/editor/complete';
import {
  diagnose, matchBracket, applyQuickFixes, offsetToLineCol,
  type Diagnostic,
} from '../../core/editor/diagnostics';
import WorkbenchTabs from '../layout/WorkbenchTabs';

// Map a file name to a highlighter language hint. Only the language *family*
// matters to the scanner (it mostly cares about comment style), so this can stay
// small.
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', json5: 'json',
  css: 'css', scss: 'css', less: 'css', html: 'html', xml: 'xml', svg: 'xml', vue: 'html',
  md: 'markdown', mdx: 'markdown',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', conf: 'conf', env: 'bash', sql: 'sql',
};

function extToLang(filePath: string): string {
  const name = (filePath.split('/').pop() || filePath).toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  return EXT_LANG[ext] || ext || 'text';
}

// Shared metrics — pre, textarea, gutter and line-background rows MUST match
// exactly or the highlight layer drifts out from under the caret.
const FONT = "'SF Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const LINE_H = 20;
const SURFACE: React.CSSProperties = {
  fontFamily: FONT, fontSize: 13, lineHeight: `${LINE_H}px`, tabSize: 2,
  padding: 12, margin: 0, whiteSpace: 'pre', overflowWrap: 'normal',
};

interface FindState {
  open: boolean;
  replaceOpen: boolean;
  query: string;
  replace: string;
  matchCase: boolean;
  index: number;
}

interface SuggestState {
  items: CompletionItem[];
  index: number;
  x: number;
  y: number;
  replaceStart: number;
}

// Pair characters the editor handles itself (close/skip/wrap).
const PAIR_CHARS = '()[]{}"\'`';
const WRAP_CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };

/** Monospace advance in px, measured once so the popup/decorations sit on the grid. */
function measureCharWidth(): number {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return 7.81;
    ctx.font = `13px 'SF Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    return ctx.measureText('MMMMMMMMMM').width / 10;
  } catch {
    return 7.81;
  }
}

export default function EditorPanel() {
  const { selectedFile, fileContent, selectedFileIsImage, saveFile, rootPath } = useWorkspaceStore();
  const setTabDirty = useWorkspaceStore((s) => s.setTabDirty);
  const dirtyTabs = useWorkspaceStore((s) => s.dirtyTabs);
  const setEditorDirty = useUIStore((s) => s.setEditorDirty);
  const aiLinesForFile = useAiHighlightsStore((s) => (selectedFile ? s.lines[selectedFile] : undefined));
  const clearAiFile = useAiHighlightsStore((s) => s.clearFile);
  const retainAiLines = useAiHighlightsStore((s) => s.retainExistingLines);
  const { t } = useLanguageStore();

  // Per-tab buffers so switching tabs never loses unsaved edits.
  const buffersRef = useRef<Record<string, string>>({});
  const originalsRef = useRef<Record<string, string>>({});
  const prevFileRef = useRef<string | null>(null);

  const [content, setContent] = useState('');
  const [cursor, setCursor] = useState(0);
  const [find, setFind] = useState<FindState>({ open: false, replaceOpen: false, query: '', replace: '', matchCase: false, index: 0 });
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoValue, setGotoValue] = useState('');
  const [suggest, setSuggest] = useState<SuggestState | null>(null);
  const [problems, setProblems] = useState<Diagnostic[]>([]);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [bracketPair, setBracketPair] = useState<{ a: number; b: number } | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const decorRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const suggestRef = useRef<SuggestState | null>(null);
  useEffect(() => { suggestRef.current = suggest; }, [suggest]);
  const charW = useMemo(measureCharWidth, []);
  const files = useWorkspaceStore((s) => s.files);
  const extraRoots = useWorkspaceStore((s) => s.extraRoots);

  // Load / switch files. Unsaved buffers survive tab switches; a fresh disk
  // load (AI edit, external change) replaces the buffer only when clean.
  useEffect(() => {
    const prev = prevFileRef.current;
    if (prev && prev !== selectedFile) {
      buffersRef.current[prev] = content;
    }
    prevFileRef.current = selectedFile ?? null;
    if (!selectedFile) {
      setContent('');
      return;
    }
    const disk = fileContent ?? '';
    const prevOriginal = originalsRef.current[selectedFile];
    const existing = buffersRef.current[selectedFile];
    const wasClean = existing === undefined || existing === prevOriginal || prevOriginal === undefined;
    originalsRef.current[selectedFile] = disk;
    if (existing !== undefined && !wasClean) {
      // User has unsaved edits — keep them; the disk changed underneath.
      setContent(existing);
    } else {
      buffersRef.current[selectedFile] = disk;
      setContent(disk);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile, fileContent]);

  const modified = selectedFile ? content !== (originalsRef.current[selectedFile] ?? fileContent ?? '') : false;

  // Publish per-tab dirty state for the tab strip; keep the legacy global flag
  // in sync so older badges don't go stale.
  useEffect(() => {
    if (!selectedFile) return;
    setTabDirty(selectedFile, modified);
  }, [selectedFile, modified, setTabDirty]);
  useEffect(() => {
    setEditorDirty(Object.keys(dirtyTabs).length > 0);
    return () => setEditorDirty(false);
  }, [dirtyTabs, setEditorDirty]);

  const lang = useMemo(() => extToLang(selectedFile || ''), [selectedFile]);
  const highlighted = useMemo(() => highlightCode(content, lang), [content, lang]);
  const lines = useMemo(() => content.split('\n'), [content]);
  const lineCount = lines.length;
  const gutterDigits = Math.max(2, String(lineCount).length);
  const aiSet = useMemo(() => new Set(aiLinesForFile ?? []), [aiLinesForFile]);

  const cursorLine = useMemo(() => content.slice(0, cursor).split('\n').length, [content, cursor]);
  const cursorCol = useMemo(() => {
    const before = content.slice(0, cursor);
    return before.slice(before.lastIndexOf('\n') + 1).length + 1;
  }, [content, cursor]);

  const fileSize = useMemo(() => new Blob([content]).size, [content]);

  // ---- find ---------------------------------------------------------------
  const matches = useMemo(() => {
    if (!find.query) return [] as number[];
    const hay = find.matchCase ? content : content.toLowerCase();
    const needle = find.matchCase ? find.query : find.query.toLowerCase();
    const out: number[] = [];
    let i = hay.indexOf(needle);
    while (i !== -1 && out.length < 2000) {
      out.push(i);
      i = hay.indexOf(needle, i + Math.max(1, needle.length));
    }
    return out;
  }, [content, find.query, find.matchCase]);

  const jumpToMatch = useCallback((pos: number) => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.selectionStart = ta.selectionEnd = pos;
    setCursor(pos);
    const line = content.slice(0, pos).split('\n').length;
    ta.scrollTop = Math.max(0, (line - 1) * LINE_H - ta.clientHeight / 2);
    syncScroll();
  }, [content]);

  useEffect(() => {
    if (find.open) findInputRef.current?.focus();
  }, [find.open]);

  const stepMatch = (dir: 1 | -1) => {
    if (!matches.length) return;
    const next = (find.index + dir + matches.length) % matches.length;
    setFind((f) => ({ ...f, index: next }));
    jumpToMatch(matches[next]);
  };

  const replaceCurrent = () => {
    if (!matches.length) return;
    const pos = matches[find.index];
    const next = content.slice(0, pos) + find.replace + content.slice(pos + find.query.length);
    commitEdit(next, pos + find.replace.length);
  };

  const replaceAll = () => {
    if (!find.query) return;
    const parts = content.split(find.matchCase ? find.query : new RegExp(escapeRegExp(find.query), 'gi'));
    // Case-insensitive split loses original casing context; do a manual rebuild.
    let out = '';
    let i = 0;
    const hay = find.matchCase ? content : content.toLowerCase();
    const needle = find.matchCase ? find.query : find.query.toLowerCase();
    let idx = hay.indexOf(needle);
    let count = 0;
    while (idx !== -1 && count < 2000) {
      out += content.slice(i, idx) + find.replace;
      i = idx + needle.length;
      idx = hay.indexOf(needle, i);
      count++;
    }
    out += content.slice(i);
    commitEdit(out, 0);
    void parts;
  };

  // ---- editing -------------------------------------------------------------
  const commitEdit = (value: string, cursorPos?: number, selEnd?: number) => {
    if (selectedFile) buffersRef.current[selectedFile] = value;
    setContent(value);
    if (selectedFile) retainAiLines(selectedFile, value);
    if (cursorPos !== undefined) {
      setCursor(cursorPos);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.selectionStart = cursorPos;
          ta.selectionEnd = selEnd ?? cursorPos;
        }
      });
    }
  };

  /** Apply a pure TextEdit and optionally keep completing at the new caret. */
  const applyTextEdit = (edit: TextEdit, keepSuggest = false) => {
    commitEdit(edit.text, edit.cursor, edit.selEnd);
    if (keepSuggest) refreshSuggest(edit.text, edit.selEnd ?? edit.cursor);
    else setSuggest(null);
  };

  // ---- paths for import completion -----------------------------------------
  const pathScopes = useMemo(() => {
    const scopes: { root: string; paths: string[] }[] = [];
    if (rootPath) scopes.push({ root: rootPath, paths: flattenPaths(files, rootPath) });
    for (const r of extraRoots || []) scopes.push({ root: r.path, paths: flattenPaths(r.files, r.path) });
    return scopes;
  }, [files, extraRoots, rootPath]);

  const pathScope = useMemo(() => {
    if (!selectedFile) return null;
    const hit = pathScopes.find((s) => selectedFile === s.root || selectedFile.startsWith(s.root + '/'));
    return hit ?? pathScopes[0] ?? null;
  }, [pathScopes, selectedFile]);

  const currentDir = useMemo(() => {
    if (!selectedFile || !pathScope) return '';
    const rel = selectedFile.startsWith(pathScope.root + '/')
      ? selectedFile.slice(pathScope.root.length + 1)
      : selectedFile.split('/').pop() || '';
    const slash = rel.lastIndexOf('/');
    return slash === -1 ? '' : rel.slice(0, slash);
  }, [selectedFile, pathScope]);

  // ---- autocomplete ----------------------------------------------------------
  const positionPopup = (text: string, pos: number, rows: number): { x: number; y: number } => {
    const ta = taRef.current;
    const before = text.slice(0, pos);
    const line = before.split('\n').length;
    const colChars = before.slice(before.lastIndexOf('\n') + 1).replace(/\t/g, '  ').length;
    const boxW = surfaceRef.current?.clientWidth ?? 600;
    const boxH = surfaceRef.current?.clientHeight ?? 400;
    const popupW = 240;
    const popupH = Math.min(Math.min(rows, 8) * 26 + 8, 216);
    const x = Math.max(12, Math.min(12 + colChars * charW - (ta?.scrollLeft ?? 0), Math.max(12, boxW - popupW - 8)));
    let y = 12 + line * LINE_H - (ta?.scrollTop ?? 0);
    if (y + popupH > boxH - 8) y = 12 + (line - 1) * LINE_H - (ta?.scrollTop ?? 0) - popupH;
    return { x, y };
  };

  const refreshSuggest = (next: string, pos: number, force = false) => {
    let ctx = suggestContext(next, pos);
    if (!ctx && force) ctx = { mode: 'word', prefix: '', replaceStart: pos };
    if (!ctx) { setSuggest(null); return; }
    const items = filterCompletions(
      candidates(ctx, { lang, doc: next, files: pathScope?.paths || [], currentDir }),
      ctx.prefix,
    );
    if (!items.length) { setSuggest(null); return; }
    const { x, y } = positionPopup(next, pos, items.length);
    setSuggest({ items, index: 0, x, y, replaceStart: ctx.replaceStart });
  };

  const acceptSuggest = (item?: CompletionItem) => {
    const s = suggestRef.current;
    const it = item ?? s?.items[s?.index ?? 0];
    if (!s || !it) return;
    const { text, cursorOffset } = splitInsert(it.insert);
    const next = content.slice(0, s.replaceStart) + text + content.slice(cursor);
    const pos = s.replaceStart + cursorOffset;
    commitEdit(next, pos);
    // Descending into a directory keeps completing inside it.
    if (it.keepOpen) refreshSuggest(next, pos);
    else setSuggest(null);
  };

  // ---- diagnostics -------------------------------------------------------------
  useEffect(() => {
    if (!selectedFile || content.length > 500_000) { setProblems([]); return; }
    const timer = setTimeout(() => setProblems(diagnose(content, lang)), 350);
    return () => clearTimeout(timer);
  }, [content, lang, selectedFile]);

  // Bracket pair glow while the caret touches either end. Skipped in huge
  // files where the backwards scan would add typing latency.
  useEffect(() => {
    if (content.length > 200_000) { setBracketPair(null); return; }
    const before = content[cursor - 1];
    const at = content[cursor];
    const pos = before && '()[]{}'.includes(before)
      ? cursor - 1
      : at && '()[]{}'.includes(at) ? cursor : -1;
    if (pos < 0) { setBracketPair(null); return; }
    const m = matchBracket(content, lang, pos);
    setBracketPair(m === null ? null : { a: pos, b: m });
  }, [content, cursor, lang]);

  // A fresh file gets a fresh popup/problems-anchor state.
  useEffect(() => { setSuggest(null); }, [selectedFile]);

  // Keep the keyboard-cycled row visible in a long suggestion list.
  useEffect(() => {
    if (!suggest) return;
    popupRef.current?.querySelector(`[data-idx="${suggest.index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [suggest]);

  const errCount = useMemo(() => problems.filter((d) => d.severity === 'error').length, [problems]);
  const warnCount = useMemo(() => problems.length - errCount, [problems, errCount]);

  const jumpToPos = (line: number, col: number) => {
    const ta = taRef.current;
    const arr = content.split('\n');
    const l = Math.min(Math.max(1, line), arr.length);
    const lineText = arr[l - 1] ?? '';
    const c = Math.min(Math.max(1, col), lineText.length + 1);
    const pos = arr.slice(0, l - 1).join('\n').length + (l > 1 ? 1 : 0) + (c - 1);
    if (ta) {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = pos;
      ta.scrollTop = Math.max(0, (l - 1) * LINE_H - ta.clientHeight / 2);
      syncScroll();
    }
    setCursor(pos);
    setSuggest(null);
  };

  const handleFixAll = () => {
    const r = applyQuickFixes(content, lang);
    if (r.text === content) return;
    commitEdit(r.text, Math.min(cursor, r.text.length));
    setSuggest(null);
  };

  const handleSave = async () => {
    if (!selectedFile) return;
    await saveFile(content);
    originalsRef.current[selectedFile] = content;
    buffersRef.current[selectedFile] = content;
    setTabDirty(selectedFile, false);
  };

  // Keep the highlight, background, decoration and gutter layers pinned to the textarea.
  const syncScroll = () => {
    const ta = taRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (bgRef.current) {
      bgRef.current.scrollTop = ta.scrollTop;
      bgRef.current.scrollLeft = ta.scrollLeft;
    }
    if (decorRef.current) {
      decorRef.current.scrollTop = ta.scrollTop;
      decorRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  };

  // Scrolling moves the text out from under the popup — dismiss it.
  const handleSurfaceScroll = () => {
    syncScroll();
    if (suggestRef.current) setSuggest(null);
  };

  const updateCursor = () => {
    const ta = taRef.current;
    if (ta) setCursor(ta.selectionStart ?? 0);
  };

  const indentSelection = (outdent: boolean) => {
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart ?? 0;
    const e = ta.selectionEnd ?? 0;
    const startLine = content.slice(0, s).split('\n').length - 1;
    const endLine = content.slice(0, e).split('\n').length - 1;
    const arr = content.split('\n');
    for (let i = startLine; i <= endLine; i++) {
      if (outdent) arr[i] = arr[i].replace(/^  /, '');
      else arr[i] = '  ' + arr[i];
    }
    const next = arr.join('\n');
    commitEdit(next);
    requestAnimationFrame(() => {
      ta.selectionStart = s + (outdent ? -Math.min(2, s - content.lastIndexOf('\n', s - 1) - 1) : 2);
      ta.selectionEnd = e + (outdent ? -(endLine - startLine + 1) * 2 : (endLine - startLine + 1) * 2);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? cursor;
    const caretEnd = ta?.selectionEnd ?? cursor;

    // 0. Suggestion popup eats navigation/accept/dismiss first.
    if (suggestRef.current) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSuggest((s) => (s ? { ...s, index: (s.index + 1) % s.items.length } : s));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSuggest((s) => (s ? { ...s, index: (s.index - 1 + s.items.length) % s.items.length } : s));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        acceptSuggest();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSuggest(null);
        return;
      }
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
        setSuggest(null);
      }
    }
    if (mod && e.key === ' ') {
      e.preventDefault();
      refreshSuggest(content, caret, true);
      return;
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (modified) void handleSave();
      return;
    }
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      setGotoOpen(false);
      setFind((f) => ({ ...f, open: true }));
      return;
    }
    if (mod && e.key.toLowerCase() === 'h') {
      e.preventDefault();
      setGotoOpen(false);
      setFind((f) => ({ ...f, open: true, replaceOpen: true }));
      return;
    }
    if (mod && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      setFind((f) => ({ ...f, open: false }));
      setGotoOpen(true);
      return;
    }
    if (e.key === 'Escape') {
      setFind((f) => ({ ...f, open: false }));
      setGotoOpen(false);
      return;
    }
    // Toggle line comment.
    if (mod && (e.key === '/' || e.code === 'Slash')) {
      e.preventDefault();
      if (ta) {
        const r = toggleComment(content, caret, caretEnd, lang);
        applyTextEdit(r);
      }
      return;
    }
    // Move / duplicate lines.
    if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (ta) {
        const dir = e.key === 'ArrowUp' ? -1 : 1;
        const r = e.shiftKey
          ? duplicateLines(content, caret, caretEnd, dir)
          : moveLines(content, caret, caretEnd, dir);
        applyTextEdit(r);
      }
      return;
    }
    // Delete line.
    if (mod && e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (ta) applyTextEdit(deleteLines(content, caret, caretEnd));
      return;
    }
    // Select next occurrence.
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      if (ta) {
        const r = selectNextOccurrence(content, caret, caretEnd);
        if (r) {
          ta.focus();
          setCursor(r.end);
          requestAnimationFrame(() => {
            ta.selectionStart = r.start;
            ta.selectionEnd = r.end;
          });
        }
      }
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      indentSelection(e.shiftKey);
      return;
    }
    // Smart Enter.
    if (e.key === 'Enter' && !mod && !e.altKey) {
      e.preventDefault();
      applyTextEdit(computeEnterEdit(content, caret, lang), true);
      return;
    }
    // Pair handling (no modifiers — let shortcuts and pastes pass through).
    if (!mod && !e.altKey && e.key.length === 1 && PAIR_CHARS.includes(e.key)) {
      if (ta && caret !== caretEnd && WRAP_CLOSE[e.key]) {
        e.preventDefault();
        const close = WRAP_CLOSE[e.key];
        const next = content.slice(0, caret) + e.key + content.slice(caret, caretEnd) + close + content.slice(caretEnd);
        commitEdit(next, caret + 1, caretEnd + 1);
        setSuggest(null);
        return;
      }
      if (ta && caret === caretEnd) {
        if (e.key === '}') {
          const out = braceOutdent(content, caret);
          if (out) {
            e.preventDefault();
            applyTextEdit(out, true);
            return;
          }
        }
        const r = autoClose(content, caret, e.key);
        if (r) {
          e.preventDefault();
          if ('skip' in r) {
            setCursor(caret + 1);
            requestAnimationFrame(() => {
              if (taRef.current) taRef.current.selectionStart = taRef.current.selectionEnd = caret + 1;
            });
          } else {
            applyTextEdit(r, true);
          }
          return;
        }
      }
      return;
    }
    // Pair-aware backspace.
    if (e.key === 'Backspace' && !mod && !e.altKey && ta && caret === caretEnd) {
      const r = backspacePair(content, caret);
      if (r) {
        e.preventDefault();
        applyTextEdit(r, true);
      }
    }
  };

  const gotoLine = (n: number) => {
    const line = Math.min(Math.max(1, n), lineCount);
    const pos = lines.slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
    const ta = taRef.current;
    if (ta) {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = pos;
      ta.scrollTop = Math.max(0, (line - 1) * LINE_H - ta.clientHeight / 2);
      syncScroll();
    }
    setCursor(pos);
    setGotoOpen(false);
  };

  if (!selectedFile) return null;

  const fileName = selectedFile.split('/').pop() || '';
  const relPath = rootPath && selectedFile.startsWith(rootPath + '/')
    ? selectedFile.slice(rootPath.length + 1)
    : selectedFile;
  const crumbs = relPath.split('/');
  const aiCount = aiSet.size;

  return (
    <div className="flex flex-col h-full bg-[var(--bg-0)] min-w-0">
      <WorkbenchTabs
        active="code"
        subtitle={selectedFile}
        actions={modified && !selectedFileIsImage ? (
          <button onClick={() => void handleSave()}
            className="px-2 py-1 rounded-lg bg-[var(--accent)] text-white text-xs hover:bg-[var(--accent-hover)] flex items-center gap-1 transition-colors">
            <FiSave size={12} /> {t('save')}
          </button>
        ) : undefined}
      />

      {/* Breadcrumb — folder trail plus AI badge, like VS Code's title bar. */}
      <div className="flex items-center gap-1 px-3 py-1 border-b border-[var(--border)] text-[11px] text-[var(--text-muted)] overflow-x-auto whitespace-nowrap shrink-0">
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1 shrink-0">
            {i > 0 && <span className="opacity-50">/</span>}
            <span className={i === crumbs.length - 1 ? 'text-[var(--text-primary)] font-medium' : undefined}>{c}</span>
          </span>
        ))}
        <span className="flex-1" />
        {aiCount > 0 && (
          <button
            onClick={() => selectedFile && clearAiFile(selectedFile)}
            title={t('clearAiMarks')}
            className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[var(--success)]/15 text-[var(--success)] text-[10px] font-medium hover:bg-[var(--success)]/25 transition-colors"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)]" />
            {t('aiChanges')} · {aiCount} · {t('clear')}
          </button>
        )}
      </div>

      {/* Find / replace bar */}
      {find.open && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--bg-1)] shrink-0 flex-wrap">
          <FiSearch size={13} className="text-[var(--text-muted)] shrink-0" />
          <input
            ref={findInputRef}
            value={find.query}
            onChange={(e) => setFind((f) => ({ ...f, query: e.target.value, index: 0 }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1); }
              if (e.key === 'Escape') setFind((f) => ({ ...f, open: false }));
            }}
            placeholder={t('find')}
            spellCheck={false}
            className="w-40 bg-[var(--bg-2)] border border-[var(--border)] rounded-lg px-2 py-1 text-[12px] outline-none focus:border-[var(--accent)]"
          />
          {find.replaceOpen && (
            <input
              value={find.replace}
              onChange={(e) => setFind((f) => ({ ...f, replace: e.target.value }))}
              placeholder={t('replace')}
              spellCheck={false}
              className="w-32 bg-[var(--bg-2)] border border-[var(--border)] rounded-lg px-2 py-1 text-[12px] outline-none focus:border-[var(--accent)]"
            />
          )}
          <span className="text-[11px] text-[var(--text-muted)] min-w-[48px] text-center">
            {find.query ? `${matches.length ? Math.min(find.index + 1, matches.length) : 0}/${matches.length}` : ''}
          </span>
          <button onClick={() => stepMatch(-1)} title={t('findPrev')} className="p-1 rounded hover:bg-[var(--bg-3)] text-[var(--text-muted)]">
            <FiChevronUp size={13} />
          </button>
          <button onClick={() => stepMatch(1)} title={t('findNext')} className="p-1 rounded hover:bg-[var(--bg-3)] text-[var(--text-muted)]">
            <FiChevronDown size={13} />
          </button>
          <button onClick={() => setFind((f) => ({ ...f, matchCase: !f.matchCase }))}
            title={t('matchCase')}
            className={`px-1.5 py-0.5 rounded text-[11px] font-mono ${find.matchCase ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-3)]'}`}>
            Aa
          </button>
          {find.replaceOpen && (
            <>
              <button onClick={replaceCurrent} className="px-2 py-0.5 rounded text-[11px] bg-[var(--bg-3)] hover:bg-[var(--bg-4)]">{t('replaceOne')}</button>
              <button onClick={replaceAll} className="px-2 py-0.5 rounded text-[11px] bg-[var(--bg-3)] hover:bg-[var(--bg-4)]">{t('replaceAll')}</button>
            </>
          )}
          <button onClick={() => setFind((f) => ({ ...f, replaceOpen: !f.replaceOpen }))} title={t('toggleReplace')}
            className="px-1.5 py-0.5 rounded text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-3)]">.*</button>
          <button onClick={() => setFind((f) => ({ ...f, open: false }))} className="p-1 rounded hover:bg-[var(--bg-3)] text-[var(--text-muted)]">
            <FiX size={13} />
          </button>
        </div>
      )}

      {/* Go to line */}
      {gotoOpen && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--bg-1)] shrink-0">
          <span className="text-[11px] text-[var(--text-muted)]">:</span>
          <input
            autoFocus
            value={gotoValue}
            onChange={(e) => setGotoValue(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && gotoValue) gotoLine(Number(gotoValue));
              if (e.key === 'Escape') setGotoOpen(false);
            }}
            placeholder={t('goToLinePlaceholder').replace('{max}', String(lineCount))}
            spellCheck={false}
            className="w-44 bg-[var(--bg-2)] border border-[var(--border)] rounded-lg px-2 py-1 text-[12px] outline-none focus:border-[var(--accent)]"
          />
          <button onClick={() => gotoValue && gotoLine(Number(gotoValue))} className="px-2 py-1 rounded text-[11px] bg-[var(--bg-3)] hover:bg-[var(--bg-4)]">{t('goToLine')}</button>
          <button onClick={() => setGotoOpen(false)} className="p-1 rounded hover:bg-[var(--bg-3)] text-[var(--text-muted)]">
            <FiX size={13} />
          </button>
        </div>
      )}

      {selectedFileIsImage ? (
        <div className="flex-1 overflow-auto flex items-center justify-center p-6 bg-[var(--bg-0)]">
          {fileContent ? (
            <img src={fileContent} alt={fileName}
              className="max-w-full max-h-full object-contain rounded shadow-lg" />
          ) : (
            <span className="text-sm text-[var(--text-muted)]">{t('cannotPreview')}</span>
          )}
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex bg-[var(--bg-0)]">
          {/* Line-number gutter with AI markers + active line */}
          <div ref={gutterRef}
            className="overflow-hidden select-none text-right text-[var(--text-muted)] border-r border-[var(--border)] bg-[var(--bg-0)] shrink-0"
            style={{ width: `calc(${gutterDigits}ch + 28px)`, ...SURFACE, padding: 0, whiteSpace: 'normal' }}>
            <div style={{ paddingTop: 12, paddingBottom: 12, paddingLeft: 4, paddingRight: 0 }}>
              {Array.from({ length: lineCount }, (_, idx) => {
                const n = idx + 1;
                const isAi = aiSet.has(n);
                const isActive = n === cursorLine;
                return (
                  <div key={idx} style={{ height: LINE_H }}
                    className={`flex items-stretch justify-end ${isActive ? 'text-[var(--text-primary)] font-medium' : ''}`}>
                    {isAi && <span className="w-[3px] rounded-full bg-[var(--success)] mr-1 my-[3px]" />}
                    <span className={`pr-3 ${isAi ? 'text-[var(--success)]' : ''}`}>{n}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Code surface: line-background layer, decoration layer, highlight layer, transparent textarea */}
          <div ref={surfaceRef} className="relative flex-1 min-w-0">
            <div ref={bgRef} aria-hidden
              className="absolute inset-0 overflow-hidden pointer-events-none"
              style={{ ...SURFACE, padding: 0 }}>
              <div style={{ paddingTop: 12, paddingBottom: 12 }}>
                {Array.from({ length: lineCount }, (_, idx) => {
                  const n = idx + 1;
                  const isAi = aiSet.has(n);
                  const isActive = n === cursorLine;
                  return (
                    <div key={idx} style={{ height: LINE_H }}
                      className={`${isAi ? 'bg-[var(--success)]/15' : ''} ${isActive ? (isAi ? '' : 'bg-[var(--bg-1)]') : ''}`} />
                  );
                })}
              </div>
            </div>
            <pre ref={preRef} aria-hidden
              className="absolute inset-0 overflow-hidden text-[var(--text-primary)] pointer-events-none"
              style={SURFACE}><code>{highlighted}</code></pre>
            {/* Decoration layer: error/warning squiggles + bracket-match glow. */}
            <div ref={decorRef} aria-hidden
              className="absolute inset-0 overflow-hidden pointer-events-none"
              style={{ ...SURFACE, padding: 0 }}>
              <div style={{ position: 'relative', width: 'max-content', minWidth: '100%', height: lineCount * LINE_H + 24 }}>
                {problems.slice(0, 200).map((d, i) => (
                  <span key={i}
                    className={d.severity === 'error' ? 'squiggle-error' : 'squiggle-warning'}
                    style={{
                      left: 12 + (d.col - 1) * charW,
                      top: 12 + (d.line - 1) * LINE_H,
                      width: Math.max(4, (d.endCol - d.col) * charW),
                      height: LINE_H,
                    }} />
                ))}
                {bracketPair && [bracketPair.a, bracketPair.b].map((off) => {
                  const lc = offsetToLineCol(content, off);
                  return (
                    <span key={off} className="bracket-match"
                      style={{
                        left: 12 + (lc.col - 1) * charW - 1,
                        top: 12 + (lc.line - 1) * LINE_H + 1,
                        width: charW + 2,
                        height: LINE_H - 2,
                      }} />
                  );
                })}
              </div>
            </div>
            <textarea ref={taRef} value={content}
              onChange={(e) => {
                const v = e.target.value;
                const p = e.target.selectionStart ?? 0;
                commitEdit(v, p);
                refreshSuggest(v, p);
              }}
              onKeyDown={handleKeyDown}
              onScroll={handleSurfaceScroll}
              onSelect={updateCursor}
              onKeyUp={updateCursor}
              onClick={() => { updateCursor(); setSuggest(null); }}
              onBlur={() => setSuggest(null)}
              spellCheck={false}
              className="absolute inset-0 w-full h-full overflow-auto bg-transparent text-transparent resize-none outline-none"
              style={{ ...SURFACE, caretColor: 'var(--text-primary)', border: 'none' }} />
            {/* Autocomplete popup */}
            {suggest && (
              <div onMouseDown={(e) => e.preventDefault()}
                className="absolute z-20 w-60 rounded-xl border border-[var(--border)] bg-[var(--bg-2)] shadow-xl overflow-hidden anim-menu"
                style={{ left: suggest.x, top: suggest.y }}>
                <div ref={popupRef} className="max-h-52 overflow-y-auto py-1">
                  {suggest.items.map((item, i) => (
                    <button key={`${item.kind}:${item.label}:${i}`} data-idx={i}
                      onClick={() => acceptSuggest(item)}
                      onMouseEnter={() => setSuggest((s) => (s ? { ...s, index: i } : s))}
                      className={`w-full h-[26px] flex items-center gap-2 px-2.5 text-left text-[12px] ${i === suggest.index ? 'bg-[var(--accent-soft)]' : ''}`}>
                      <span className={`w-4 h-4 rounded text-[10px] font-bold flex items-center justify-center shrink-0 ${KIND_BADGE[item.kind]}`}>
                        {item.kind[0].toUpperCase()}
                      </span>
                      <span className="flex-1 truncate font-mono">{item.label}</span>
                      {item.detail && (
                        <span className="text-[10px] text-[var(--text-muted)] truncate max-w-[110px]">{item.detail}</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Problems panel — diagnostics list with jump-to-error and Fix all. */}
      {problemsOpen && problems.length > 0 && !selectedFileIsImage && (
        <div className="border-t border-[var(--border)] bg-[var(--bg-1)] shrink-0 max-h-36 flex flex-col">
          <div className="flex items-center gap-2 px-3 py-1 text-[11px] shrink-0">
            <span className="font-medium text-[var(--text-primary)]">{t('problems')} · {problems.length}</span>
            <span className="flex-1" />
            <button onClick={handleFixAll}
              className="px-2 py-0.5 rounded bg-[var(--bg-3)] hover:bg-[var(--bg-4)] text-[var(--text-secondary)]">
              {t('fixAll')}
            </button>
            <button onClick={() => setProblemsOpen(false)}
              className="p-1 rounded hover:bg-[var(--bg-3)] text-[var(--text-muted)]">
              <FiX size={13} />
            </button>
          </div>
          <div className="overflow-y-auto px-1 pb-1">
            {problems.slice(0, 100).map((d, i) => (
              <button key={i} onClick={() => jumpToPos(d.line, d.col)}
                className="w-full flex items-center gap-2 px-2 py-0.5 rounded text-left text-[11px] hover:bg-[var(--bg-3)] text-[var(--text-secondary)]">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${d.severity === 'error' ? 'bg-[var(--error)]' : 'bg-[var(--warning)]'}`} />
                <span className="flex-1 truncate">{d.message}</span>
                <span className="text-[var(--text-muted)] font-mono shrink-0">Ln {d.line}, Col {d.col}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Status bar — VS Code's bottom strip: cursor, file facts, AI marks. */}
      {!selectedFileIsImage && (
        <div className="flex items-center gap-3 px-3 py-1 border-t border-[var(--border)] bg-[var(--bg-1)] text-[11px] text-[var(--text-muted)] shrink-0 overflow-x-auto whitespace-nowrap">
          <span className="shrink-0">Ln {cursorLine}, Col {cursorCol}</span>
          <span className="shrink-0">{t('linesCount').replace('{n}', String(lineCount))}</span>
          <span className="shrink-0 uppercase">{lang}</span>
          <span className="shrink-0">UTF-8</span>
          <span className="shrink-0">{formatSize(fileSize)}</span>
          <span className="flex-1" />
          {(errCount > 0 || warnCount > 0) && (
            <button onClick={() => setProblemsOpen((o) => !o)}
              className="shrink-0 inline-flex items-center gap-2 hover:opacity-80">
              {errCount > 0 && (
                <span className="inline-flex items-center gap-1 text-[var(--error)]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--error)]" />{errCount}
                </span>
              )}
              {warnCount > 0 && (
                <span className="inline-flex items-center gap-1 text-[var(--warning)]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)]" />{warnCount}
                </span>
              )}
            </button>
          )}
          {modified && <span className="shrink-0 inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)]" />{t('unsaved')}</span>}
          {aiCount > 0 && (
            <button onClick={() => selectedFile && clearAiFile(selectedFile)}
              className="shrink-0 inline-flex items-center gap-1 text-[var(--success)] hover:opacity-80">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)]" />
              {aiCount} {t('aiChangesShort')}
            </button>
          )}
          <span className="shrink-0 hidden sm:inline">Tab: 2 {t('spaces')}</span>
        </div>
      )}
    </div>
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const KIND_BADGE: Record<string, string> = {
  snippet: 'bg-[var(--accent)] text-white',
  keyword: 'bg-[var(--syntax-keyword)]/20 text-[var(--syntax-keyword)]',
  path: 'bg-[var(--syntax-type)]/20 text-[var(--syntax-type)]',
  word: 'bg-[var(--bg-4)] text-[var(--text-muted)]',
  property: 'bg-[var(--syntax-property)]/20 text-[var(--syntax-property)]',
};
