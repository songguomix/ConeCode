import { useMemo, useState, type ReactNode } from 'react';
import {
  FiFileText, FiFolder, FiEdit3, FiFilePlus, FiFolderPlus, FiTrash2,
  FiMove, FiCopy, FiTerminal, FiExternalLink, FiInfo, FiHelpCircle, FiCheck,
  FiSearch, FiList, FiCheckSquare, FiGitBranch, FiGlobe, FiUsers, FiZap, FiDownload, FiPackage,
} from 'react-icons/fi';
import { useLanguageStore } from '../../stores';
import { highlightCode } from '../editor/highlight';

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
// ---------------------------------------------------------------------------

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)\s]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(INLINE);
  return parts.map((part, idx) => {
    const key = `${keyPrefix}-${idx}`;
    if (!part) return null;
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={key} className="px-1 py-0.5 rounded bg-[var(--bg-3)] font-mono text-[0.85em]">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('~~') && part.endsWith('~~')) {
      return <del key={key}>{part.slice(2, -2)}</del>;
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith('_') && part.endsWith('_')) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (link) {
      const url = link[2];
      if (!/^https?:\/\//i.test(url)) return <span key={key}>{link[1]}</span>;
      return (
        <a key={key} href={url}
          onClick={(e) => { e.preventDefault(); window.electronAPI.app?.open?.(url); }}
          className="text-[var(--accent)] underline hover:opacity-80 cursor-pointer">
          {link[1]}
        </a>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

function MarkdownText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushPara = () => {
    if (!para.length) return;
    blocks.push(
      <p key={`p${key++}`} className="leading-relaxed">
        {para.map((l, i) => (
          <span key={i}>{i > 0 && <br />}{renderInline(l, `p${key}-${i}`)}</span>
        ))}
      </p>
    );
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const { ordered, items } = list;
    const cls = 'my-1 pl-5 space-y-0.5 ' + (ordered ? 'list-decimal' : 'list-disc');
    blocks.push(ordered
      ? <ol key={`l${key++}`} className={cls}>{items.map((it, i) => <li key={i}>{renderInline(it, `li${key}-${i}`)}</li>)}</ol>
      : <ul key={`l${key++}`} className={cls}>{items.map((it, i) => <li key={i}>{renderInline(it, `li${key}-${i}`)}</li>)}</ul>);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const ulItem = line.match(/^\s*[-*]\s+(.*)$/);
    const olItem = line.match(/^\s*\d+\.\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);
    const hr = /^(-{3,}|\*{3,})$/.test(line.trim());

    if (line.trim() === '') { flushPara(); flushList(); continue; }

    if (heading) {
      flushPara(); flushList();
      const level = heading[1].length;
      const txt = heading[2];
      const sz = level === 1 ? 'text-[16px]' : level === 2 ? 'text-[15px]' : 'text-[14px]';
      blocks.push(<div key={`h${key++}`} className={`font-semibold mt-2 mb-0.5 ${sz}`}>{renderInline(txt, `h${key}`)}</div>);
    } else if (hr) {
      flushPara(); flushList();
      blocks.push(<hr key={`hr${key++}`} className="my-2 border-[var(--border)]" />);
    } else if (ulItem || olItem) {
      flushPara();
      const ordered = !!olItem;
      const item = (ulItem ? ulItem[1] : olItem![1]);
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push(item);
    } else if (quote) {
      flushPara(); flushList();
      blocks.push(
        <blockquote key={`q${key++}`} className="border-l-2 border-[var(--accent)] pl-3 my-1 text-[var(--text-secondary)]">
          {renderInline(quote[1], `q${key}`)}
        </blockquote>
      );
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();

  return <div className="space-y-1.5">{blocks}</div>;
}

// ---------------------------------------------------------------------------

export default function MessageContent({
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
      {streaming && <span className="animate-pulse">▌</span>}
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
