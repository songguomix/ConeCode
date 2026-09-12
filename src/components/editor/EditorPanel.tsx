import { useState, useEffect, useRef, useMemo } from 'react';
import { FiSave } from 'react-icons/fi';
import { useWorkspaceStore, useLanguageStore, useUIStore } from '../../stores';
import { highlightCode } from './highlight';
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

// Shared metrics — pre, textarea and gutter rows MUST match exactly or the
// highlight layer drifts out from under the caret.
const FONT = "'SF Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const SURFACE: React.CSSProperties = {
  fontFamily: FONT, fontSize: 13, lineHeight: '20px', tabSize: 2,
  padding: 12, margin: 0, whiteSpace: 'pre', overflowWrap: 'normal',
};

export default function EditorPanel() {
  const { selectedFile, fileContent, selectedFileIsImage, saveFile } = useWorkspaceStore();
  const setEditorDirty = useUIStore((s) => s.setEditorDirty);
  const { t } = useLanguageStore();
  const [content, setContent] = useState('');
  const [modified, setModified] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setContent(fileContent || '');
    setModified(false);
  }, [selectedFile, fileContent]);

  // The tab strip is shared with the preview, so the unsaved marker has to live
  // where both can see it.
  useEffect(() => {
    setEditorDirty(modified);
    return () => setEditorDirty(false);
  }, [modified, setEditorDirty]);

  const lang = useMemo(() => extToLang(selectedFile || ''), [selectedFile]);
  const highlighted = useMemo(() => highlightCode(content, lang), [content, lang]);
  const lineCount = useMemo(() => content.split('\n').length, [content]);
  const gutterDigits = Math.max(2, String(lineCount).length);

  const handleSave = async () => {
    await saveFile(content);
    setModified(false);
  };

  const handleChange = (value: string) => {
    setContent(value);
    setModified(true);
  };

  // Keep the highlight layer and gutter pinned to the textarea's scroll position.
  const syncScroll = () => {
    const ta = taRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (modified) handleSave();
      return;
    }
    // Tab inserts two spaces instead of moving focus.
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const { selectionStart: s, selectionEnd: en } = ta;
      const next = content.slice(0, s) + '  ' + content.slice(en);
      setContent(next);
      setModified(true);
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
    }
  };

  if (!selectedFile) return null;

  const fileName = selectedFile.split('/').pop() || '';

  return (
    <div className="flex flex-col h-full bg-[var(--bg-0)]">
      <WorkbenchTabs
        active="code"
        subtitle={selectedFile}
        actions={modified && !selectedFileIsImage ? (
          <button onClick={handleSave}
            className="px-2 py-1 rounded-lg bg-[var(--accent)] text-white text-xs hover:bg-[var(--accent-hover)] flex items-center gap-1 transition-colors">
            <FiSave size={12} /> {t('save')}
          </button>
        ) : undefined}
      />

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
          {/* Line-number gutter */}
          <div ref={gutterRef}
            className="overflow-hidden select-none text-right text-[var(--text-muted)] border-r border-[var(--border)] bg-[var(--bg-0)]"
            style={{ width: `calc(${gutterDigits}ch + 24px)`, ...SURFACE, padding: 0, whiteSpace: 'normal' }}>
            <div style={{ paddingTop: 12, paddingBottom: 12, paddingLeft: 8, paddingRight: 12 }}>
              {Array.from({ length: lineCount }, (_, idx) => (
                <div key={idx} style={{ height: 20 }}>{idx + 1}</div>
              ))}
            </div>
          </div>

          {/* Code surface: highlighted layer behind a transparent textarea */}
          <div className="relative flex-1 min-w-0">
            <pre ref={preRef} aria-hidden
              className="absolute inset-0 overflow-hidden text-[var(--text-primary)] pointer-events-none"
              style={SURFACE}><code>{highlighted}</code></pre>
            <textarea ref={taRef} value={content}
              onChange={(e) => handleChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onScroll={syncScroll}
              spellCheck={false}
              className="absolute inset-0 w-full h-full overflow-auto bg-transparent text-transparent resize-none outline-none"
              style={{ ...SURFACE, caretColor: 'var(--text-primary)', border: 'none' }} />
          </div>
        </div>
      )}
    </div>
  );
}
