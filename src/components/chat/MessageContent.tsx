import { memo, useMemo, useState, type ReactNode } from 'react';
import {
  FiFileText, FiFolder, FiEdit3, FiFilePlus, FiFolderPlus, FiTrash2,
  FiMove, FiCopy, FiTerminal, FiExternalLink, FiInfo, FiHelpCircle, FiCheck,
  FiSearch, FiList, FiCheckSquare, FiGitBranch, FiGlobe, FiUsers, FiZap, FiDownload, FiPackage,
} from 'react-icons/fi';
import { useLanguageStore } from '../../stores';
import { highlightCode } from '../editor/highlight';
import {
  parseInline, parseMarkdownBlocks,
  type MdBlock, type MdInline, type MdListItem,
} from '../../core/markdown/markdown';

// ---------------------------------------------------------------------------
// Segment parsing: split assistant text into prose / code / tool-action blocks.
// ---------------------------------------------------------------------------

interface AnyAction {
  action: string;
  path?: string;
  oldPath?: string;
  newPath?: string;
  srcPath?: string;
  destPath?: string;
  command?: string;
  name?: string;
  description?: string;
  [k: string]: any;
}

type Segment =
  | { type: 'text'; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'action'; action: AnyAction };

function parseSegments(content: string): Segment[] {
  const lines = content.split('\n');
  const segments: Segment[] = [];
  let textBuf: string[] = [];

  const flushText = () => {
    if (textBuf.length) {
      const text = textBuf.join('\n');
      if (text.trim()) segments.push({ type: 'text', text });
      textBuf = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const fence = lines[i].match(/^```(\w*)\s*$/);
    if (fence) {
      flushText();
      const lang = fence[1] || '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // skip closing fence (or past end for an in-progress stream)
      const code = body.join('\n');

      if (lang === 'json') {
        try {
          const parsed = JSON.parse(code);
          if (parsed && typeof parsed.action === 'string') {
            segments.push({ type: 'action', action: parsed });
            continue;
          }
        } catch {
          // Incomplete/invalid JSON (e.g. still streaming) — fall through to code.
        }
      }
      segments.push({ type: 'code', lang, code });
    } else {
      textBuf.push(lines[i]);
      i++;
    }
  }
  flushText();
  return segments;
}

// ---------------------------------------------------------------------------
// Tool-action cards (Claude Code style).
// ---------------------------------------------------------------------------

const base = (p?: string) => (p ? p.split('/').filter(Boolean).pop() || p : '');

function actionMeta(a: AnyAction): { icon: ReactNode; verbKey: string; detail: string; mono?: boolean; tone?: string } {
  switch (a.action) {
    case 'read_file': return { icon: <FiFileText size={13} />, verbKey: 'read', detail: base(a.path) };
    case 'list_dir': return { icon: <FiFolder size={13} />, verbKey: 'list', detail: base(a.path) || a.path || '' };
    case 'search': return { icon: <FiSearch size={13} />, verbKey: 'search', detail: a.query || '', mono: true };
    case 'glob': return { icon: <FiList size={13} />, verbKey: 'find', detail: a.pattern || '', mono: true };
    case 'edit_file': return { icon: <FiEdit3 size={13} />, verbKey: 'edit', detail: base(a.path), tone: 'text-[var(--warning)]' };
    case 'create_file': return { icon: <FiFilePlus size={13} />, verbKey: 'create', detail: base(a.path), tone: 'text-[var(--success)]' };
    case 'create_dir': return { icon: <FiFolderPlus size={13} />, verbKey: 'newFolder', detail: base(a.path), tone: 'text-[var(--success)]' };
    case 'delete': return { icon: <FiTrash2 size={13} />, verbKey: 'delete', detail: base(a.path), tone: 'text-[var(--error)]' };
    case 'rename': return { icon: <FiMove size={13} />, verbKey: 'rename', detail: `${base(a.oldPath)} → ${base(a.newPath)}` };
    case 'copy': return { icon: <FiCopy size={13} />, verbKey: 'copy', detail: `${base(a.srcPath)} → ${base(a.destPath)}` };
    case 'exec': return { icon: <FiTerminal size={13} />, verbKey: 'run', detail: a.command || '', mono: true, tone: 'text-[var(--warning)]' };
    case 'open_app': return { icon: <FiExternalLink size={13} />, verbKey: 'openApp', detail: a.name || '' };
    case 'open_path': return { icon: <FiExternalLink size={13} />, verbKey: 'open', detail: base(a.path) };
    case 'system_info': return { icon: <FiInfo size={13} />, verbKey: 'systemInfo', detail: '' };
    case 'ask_user': return { icon: <FiHelpCircle size={13} />, verbKey: 'question', detail: '' };
    case 'update_todos': return { icon: <FiCheckSquare size={13} />, verbKey: 'todos', detail: Array.isArray(a.todos) ? `${a.todos.filter((x: any) => x?.status === 'completed').length}/${a.todos.length}` : '' };
    case 'git_status': return { icon: <FiGitBranch size={13} />, verbKey: 'gitStatus', detail: '' };
    case 'git_diff': return { icon: <FiGitBranch size={13} />, verbKey: 'gitDiff', detail: base(a.path) };
    case 'web_fetch': return { icon: <FiGlobe size={13} />, verbKey: 'fetchWeb', detail: a.url || '', mono: true };
    case 'web_search': return { icon: <FiSearch size={13} />, verbKey: 'searchWeb', detail: a.query || '', mono: true };
    case 'download': return { icon: <FiDownload size={13} />, verbKey: 'downloadFile', detail: a.url || '', mono: true };
    case 'mcp_call': return { icon: <FiZap size={13} />, verbKey: 'mcpTool', detail: [a.server, a.tool].filter(Boolean).join(':'), mono: true };
    case 'use_skill': return { icon: <FiPackage size={13} />, verbKey: 'useSkill', detail: a.id || '', mono: true };
    case 'spawn_agent': return { icon: <FiUsers size={13} />, verbKey: 'subAgent', detail: (a.task || '').slice(0, 60) };
    default: return { icon: <FiInfo size={13} />, verbKey: a.action, detail: '' };
  }
}

function ActionCard({ action }: { action: AnyAction }) {
  const { t } = useLanguageStore();
  const { icon, verbKey, detail, mono, tone } = actionMeta(action);
  return (
    <div className="my-0.5 flex items-center gap-2 text-xs leading-relaxed py-0.5">
      <span className="text-[var(--text-muted)] shrink-0 ff-mono select-none opacity-50">›</span>
      <span className={`shrink-0 ${tone || 'text-[var(--text-secondary)]'}`}>{icon}</span>
      <span className="text-[var(--text-secondary)] shrink-0 font-medium">{t(verbKey)}</span>
      {detail && (
        <span className={`truncate text-[var(--text-muted)] ${mono ? 'ff-mono' : ''}`}>{detail}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Code block with copy button.
// ---------------------------------------------------------------------------

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="my-3 rounded-xl border border-[var(--border)] overflow-hidden bg-[var(--bg-2)]">
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-[var(--bg-3)]/50 border-b border-[var(--border)]">
        <span className="text-[11px] font-mono text-[var(--text-muted)]">{lang || 'text'}</span>
        <button onClick={copy} className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors">
          {copied ? <FiCheck size={11} /> : <FiCopy size={11} />}{copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="p-3.5 overflow-x-auto text-[13px] leading-relaxed font-mono text-[var(--text-primary)]"><code>{highlightCode(code, lang)}</code></pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lightweight inline + block Markdown rendering (no external deps).
// Parsing lives in core/markdown so it is unit-tested without React.
// ---------------------------------------------------------------------------

function renderInlines(tokens: MdInline[], keyPrefix: string): ReactNode[] {
  return tokens.map((tok, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (tok.type) {
      case 'code':
        return <code key={key} className="px-1 py-0.5 rounded bg-[var(--bg-3)] font-mono text-[0.85em]">{tok.text}</code>;
      case 'strong':
        return <strong key={key}>{tok.text}</strong>;
      case 'em':
        return <em key={key}>{tok.text}</em>;
      case 'del':
        return <del key={key}>{tok.text}</del>;
      case 'link':
        return (
          <a key={key} href={tok.href}
            onClick={(e) => { e.preventDefault(); window.electronAPI.app?.open?.(tok.href); }}
            className="text-[var(--accent)] underline hover:opacity-80 cursor-pointer">
            {tok.text}
          </a>
        );
      default:
        return <span key={key}>{tok.text}</span>;
    }
  });
}

function InlineText({ text, k }: { text: string; k: string }) {
  return <>{renderInlines(parseInline(text), k)}</>;
}

function ListBlock({ items, k }: { items: MdListItem[]; k: string }) {
  // Flatten consecutive same-ordered runs into one <ul>/<ol>; nesting is done
  // with padding so mixed ordered/unordered nests still line up.
  const nodes: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < items.length) {
    const ordered = items[i].ordered;
    const depth = items[i].depth;
    const run: MdListItem[] = [];
    while (i < items.length && items[i].ordered === ordered && items[i].depth === depth) {
      run.push(items[i]);
      i++;
    }
    const cls = `my-0.5 space-y-0.5 ${ordered ? 'list-decimal list-inside' : 'list-disc list-inside'}`;
    const style = { paddingLeft: `${depth * 1.1 + 0.25}rem` };
    nodes.push(
      ordered ? (
        <ol key={`${k}-o${key++}`} className={cls} style={style} start={run[0].ordinal || 1}>
          {run.map((it, idx) => (
            <li key={idx} className="marker:text-[var(--text-muted)]">
              {it.checked != null && (
                <span className={`mr-1.5 inline-flex h-3.5 w-3.5 align-[-2px] items-center justify-center rounded border text-[9px] ${
                  it.checked
                    ? 'border-[var(--success)] bg-[var(--success)] text-white'
                    : 'border-[var(--border)] bg-[var(--bg-2)]'
                }`}>
                  {it.checked ? '✓' : ''}
                </span>
              )}
              <InlineText text={it.text} k={`${k}-oli-${key}-${idx}`} />
            </li>
          ))}
        </ol>
      ) : (
        <ul key={`${k}-u${key++}`} className={cls} style={style}>
          {run.map((it, idx) => (
            <li key={idx} className="marker:text-[var(--text-muted)]">
              {it.checked != null && (
                <span className={`mr-1.5 inline-flex h-3.5 w-3.5 align-[-2px] items-center justify-center rounded border text-[9px] ${
                  it.checked
                    ? 'border-[var(--success)] bg-[var(--success)] text-white'
                    : 'border-[var(--border)] bg-[var(--bg-2)]'
                }`}>
                  {it.checked ? '✓' : ''}
                </span>
              )}
              <InlineText text={it.text} k={`${k}-uli-${key}-${idx}`} />
            </li>
          ))}
        </ul>
      ),
    );
  }
  return <>{nodes}</>;
}

function TableBlock({ block, k }: { block: Extract<MdBlock, { type: 'table' }>; k: string }) {
  const alignCls = (a: string | null) =>
    a === 'center' ? 'text-center' : a === 'right' ? 'text-right' : 'text-left';
  const cols = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1);
  const cell = (text: string | undefined, idx: number, head: boolean) => {
    const a = block.align[idx] ?? null;
    const Tag = head ? 'th' : 'td';
    return (
      <Tag
        key={idx}
        className={`px-2.5 py-1.5 border border-[var(--border)] ${alignCls(a)} ${
          head ? 'bg-[var(--bg-3)]/60 font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
        }`}
      >
        <InlineText text={text ?? ''} k={`${k}-${head ? 'h' : 'r'}-${idx}`} />
      </Tag>
    );
  };
  return (
    <div className="my-3 overflow-x-auto rounded-xl border border-[var(--border)]">
      <table className="w-full text-[13px] border-collapse">
        <thead>
          <tr>{Array.from({ length: cols }, (_, i) => cell(block.header[i], i, true))}</tr>
        </thead>
        <tbody>
          {block.rows.map((row, ri) => (
            <tr key={ri} className={ri % 2 ? 'bg-[var(--bg-2)]/40' : ''}>
              {Array.from({ length: cols }, (_, i) => cell(row[i], i, false))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MarkdownText({ text }: { text: string }) {
  const blocks = parseMarkdownBlocks(text);
  return (
    <div className="space-y-1.5">
      {blocks.map((block, i) => {
        const k = `b${i}`;
        switch (block.type) {
          case 'heading': {
            const sz =
              block.level <= 1 ? 'text-[16px]'
              : block.level === 2 ? 'text-[15px]'
              : block.level === 3 ? 'text-[14px]'
              : 'text-[13px]';
            return (
              <div key={k} className={`font-semibold mt-2 mb-0.5 ${sz}`}>
                <InlineText text={block.text} k={`${k}-h`} />
              </div>
            );
          }
          case 'hr':
            return <hr key={k} className="my-2 border-[var(--border)]" />;
          case 'quote':
            return (
              <blockquote key={k} className="border-l-2 border-[var(--accent)] pl-3 my-1 text-[var(--text-secondary)] space-y-0.5">
                {block.text.split('\n').map((line, li) => (
                  <div key={li}><InlineText text={line} k={`${k}-q-${li}`} /></div>
                ))}
              </blockquote>
            );
          case 'list':
            return <ListBlock key={k} items={block.items} k={k} />;
          case 'table':
            return <TableBlock key={k} block={block} k={k} />;
          default: {
            const lines = block.text.split('\n');
            return (
              <p key={k} className="leading-relaxed">
                {lines.map((l, li) => (
                  <span key={li}>{li > 0 && <br />}<InlineText text={l} k={`${k}-p-${li}`} /></span>
                ))}
              </p>
            );
          }
        }
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

export default memo(MessageContent);

function MessageContent({
  content,
  streaming,
  toolCalls,
}: {
  content: string;
  streaming?: boolean;
  // Native function calls made by this turn. They arrive as structured data
  // rather than ```json blocks in the text, so they're rendered as the same
  // cards after the prose.
  toolCalls?: { id: string; name: string; arguments: Record<string, any> }[];
}) {
  const segments = useMemo(() => parseSegments(content), [content]);

  return (
    <div className="text-[15px] leading-[1.6] text-[var(--text-primary)]">
      {segments.map((seg, i) => {
        if (seg.type === 'action') return <ActionCard key={i} action={seg.action} />;
        if (seg.type === 'code') return <CodeBlock key={i} lang={seg.lang} code={seg.code} />;
        return <MarkdownText key={i} text={seg.text} />;
      })}
      {toolCalls?.map((call) => <ActionCard key={call.id} action={toCardAction(call)} />)}
      {streaming && <span className="anim-caret">▌</span>}
    </div>
  );
}

// Native calls carry the tool name and a bare argument object; the cards expect
// an action object. MCP tools are advertised as `mcp__server__tool`, so unpack
// that back into the server/tool pair the MCP card renders.
function toCardAction(call: { name: string; arguments: Record<string, any> }): AnyAction {
  if (call.name.startsWith('mcp__')) {
    const rest = call.name.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    return {
      action: 'mcp_call',
      server: sep === -1 ? rest : rest.slice(0, sep),
      tool: sep === -1 ? '' : rest.slice(sep + 2),
    };
  }
  return { ...call.arguments, action: call.name };
}
