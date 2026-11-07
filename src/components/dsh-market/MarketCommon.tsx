import type { ReactNode } from 'react';
import { FiAlertTriangle, FiCheckCircle, FiHelpCircle, FiMinusCircle, FiPackage } from 'react-icons/fi';
import {
  parseInline,
  parseMarkdownBlocks,
  type MdBlock,
  type MdInline,
} from '../../core/markdown/markdown';
import type {
  CompatibilityState,
  InstalledPlugin,
  MarketPlugin,
} from '../../core/dsh-market/types';

export const compatTone: Record<CompatibilityState, string> = {
  verified: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border-emerald-500/25',
  partial: 'bg-amber-500/12 text-amber-600 dark:text-amber-400 border-amber-500/25',
  incompatible: 'bg-red-500/12 text-red-600 dark:text-red-400 border-red-500/25',
  unverified: 'bg-[var(--bg-3)] text-[var(--text-muted)] border-[var(--border)]',
};

export function CompatBadge({ state, children }: { state: CompatibilityState; children: ReactNode }) {
  const icon = state === 'verified'
    ? <FiCheckCircle size={10} />
    : state === 'partial'
      ? <FiAlertTriangle size={10} />
      : state === 'incompatible'
        ? <FiMinusCircle size={10} />
        : <FiHelpCircle size={10} />;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-medium whitespace-nowrap ${compatTone[state]}`}>
      {icon}{children}
    </span>
  );
}

export function SourceBadge({ plugin }: { plugin: MarketPlugin }) {
  const source = plugin.versions[0]?.source;
  const label = plugin.demo ? 'sample' : source?.type === 'git' ? 'git' : source?.type === 'local' ? 'local' : 'npm';
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[var(--bg-3)] text-[var(--text-muted)] border border-[var(--border)] text-[10px] font-mono">
      {label}
    </span>
  );
}

export function PluginIcon({ plugin, size = 'w-10 h-10' }: { plugin: MarketPlugin; size?: string }) {
  if (plugin.icon && /^https?:\/\//.test(plugin.icon)) {
    return <img src={plugin.icon} alt="" className={`${size} rounded-xl object-cover border border-[var(--border)] shrink-0`} referrerPolicy="no-referrer" />;
  }
  const letter = (plugin.title || plugin.name).trim().charAt(0).toUpperCase();
  return (
    <span className={`${size} rounded-xl shrink-0 flex items-center justify-center bg-[var(--accent-soft)] text-[var(--accent)] border border-[color-mix(in_srgb,var(--accent)_25%,transparent)] font-semibold text-sm`}>
      {letter || <FiPackage size={16} />}
    </span>
  );
}

export function StatusBadge({ plugin, text }: { plugin: InstalledPlugin; text: (key: string) => string }) {
  const map: Record<InstalledPlugin['status'], { label: string; tone: string }> = {
    loaded: { label: text('loaded'), tone: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400' },
    disabled: { label: text('disabled'), tone: 'bg-[var(--bg-3)] text-[var(--text-muted)]' },
    'load-failed': { label: text('loadFailed'), tone: 'bg-red-500/12 text-red-600 dark:text-red-400' },
    'missing-capability': { label: text('missingCapability'), tone: 'bg-amber-500/12 text-amber-600 dark:text-amber-400' },
    'restart-required': { label: text('restartRequired'), tone: 'bg-amber-500/12 text-amber-600 dark:text-amber-400' },
    'client-only': { label: text('clientOnly'), tone: 'bg-sky-500/12 text-sky-600 dark:text-sky-400' },
  };
  const status = map[plugin.status] || map.disabled;
  return <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-medium ${status.tone}`}>{status.label}</span>;
}

export function formatDate(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() === 0) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatNumber(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString();
}

function safeHref(href: string): boolean {
  return /^https?:\/\//i.test(href) || href.startsWith('#') || href.startsWith('./') || href.startsWith('../');
}

function Inline({ tokens, onLink, onImage }: {
  tokens: MdInline[];
  onLink: (href: string) => void;
  onImage: (src: string) => void;
}) {
  return (
    <>
      {tokens.map((token, index) => {
        if (token.type === 'text') return <span key={index}>{token.text}</span>;
        if (token.type === 'code') return <code key={index} className="px-1 py-0.5 rounded bg-[var(--bg-3)] font-mono text-[0.92em]">{token.text}</code>;
        if (token.type === 'strong') return <strong key={index} className="font-semibold text-[var(--text-primary)]">{token.text}</strong>;
        if (token.type === 'em') return <em key={index}>{token.text}</em>;
        if (token.type === 'del') return <del key={index} className="opacity-70">{token.text}</del>;
        if (token.type === 'link') {
          return (
            <button key={index} type="button" disabled={!safeHref(token.href)} onClick={() => safeHref(token.href) && onLink(token.href)}
              className="text-[var(--accent)] hover:underline disabled:no-underline disabled:opacity-60">
              {token.text || token.href}
            </button>
          );
        }
        if (token.type === 'image') {
          if (!safeHref(token.href) || !/^https?:\/\//i.test(token.href)) {
            return <span key={index} className="text-[var(--text-muted)]">{token.text || 'image'}</span>;
          }
          return (
            <button key={index} type="button" onClick={() => onImage(token.href)} className="block my-2">
              <img src={token.href} alt={token.text || ''} loading="lazy" referrerPolicy="no-referrer" className="max-h-64 max-w-full rounded-xl border border-[var(--border)] object-contain" />
            </button>
          );
        }
        return null;
      })}
    </>
  );
}

function Block({ block, onLink, onImage }: { block: MdBlock; onLink: (href: string) => void; onImage: (src: string) => void }) {
  if (block.type === 'heading') {
    const sizes = ['text-xl', 'text-lg', 'text-base', 'text-sm', 'text-sm', 'text-xs'];
    return <div className={`font-semibold text-[var(--text-primary)] mt-4 mb-1.5 ${sizes[Math.min(5, block.level - 1)]}`}>
      <Inline tokens={parseInline(block.text)} onLink={onLink} onImage={onImage} />
    </div>;
  }
  if (block.type === 'hr') return <hr className="my-4 border-[var(--border)]" />;
  if (block.type === 'quote') return (
    <blockquote className="my-2 border-l-2 border-[var(--accent)]/40 pl-3 text-[var(--text-muted)]">
      <Inline tokens={parseInline(block.text)} onLink={onLink} onImage={onImage} />
    </blockquote>
  );
  if (block.type === 'list') {
    return (
      <div className="my-2 space-y-1">
        {block.items.map((item, index) => (
          <div key={index} className="flex gap-2 text-[var(--text-secondary)]" style={{ paddingLeft: `${Math.min(item.depth, 4) * 16}px` }}>
            <span className="shrink-0 text-[var(--text-muted)]">{item.checked === true ? '☑' : item.checked === false ? '☐' : item.ordered ? `${item.ordinal || index + 1}.` : '•'}</span>
            <span><Inline tokens={parseInline(item.text)} onLink={onLink} onImage={onImage} /></span>
          </div>
        ))}
      </div>
    );
  }
  if (block.type === 'table') {
    return (
      <div className="my-3 overflow-x-auto">
        <table className="min-w-full text-[11px] border-collapse">
          <thead>
            <tr className="border-b border-[var(--border)]">
              {block.header.map((cell, index) => <th key={index} className="text-left px-2 py-1.5 font-semibold text-[var(--text-primary)]">{cell}</th>)}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b border-[var(--border)]/60">
                {row.map((cell, cellIndex) => <td key={cellIndex} className="px-2 py-1.5 text-[var(--text-secondary)] align-top">{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <p className="my-2 whitespace-pre-wrap text-[var(--text-secondary)]">
      <Inline tokens={parseInline(block.text)} onLink={onLink} onImage={onImage} />
    </p>
  );
}

function normalizeReadme(text: string): string {
  return text
    .replace(/<picture[\s\S]*?<\/picture>/gi, '')
    .replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, '![]($1)')
    .replace(/<source[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:div|span|p|sub|sup|details|summary|center|table|thead|tbody|tr|td|th|ul|li|a|picture|source|img)[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}

export function MarketMarkdown({ text, onLink, onImage }: {
  text: string;
  onLink: (href: string) => void;
  onImage: (src: string) => void;
}) {
  const lines = normalizeReadme(text).replace(/\r\n/g, '\n').split('\n');
  const nodes: ReactNode[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (!prose.length) return;
    const content = prose.join('\n');
    prose = [];
    for (const [index, block] of parseMarkdownBlocks(content).entries()) {
      nodes.push(<Block key={`p-${nodes.length}-${index}`} block={block} onLink={onLink} onImage={onImage} />);
    }
  };
  for (let index = 0; index < lines.length; index++) {
    const fence = lines[index].match(/^```([\w-]*)/);
    if (!fence) {
      prose.push(lines[index]);
      continue;
    }
    flush();
    const language = fence[1] || '';
    const code: string[] = [];
    index++;
    while (index < lines.length && !/^```/.test(lines[index])) {
      code.push(lines[index]);
      index++;
    }
    nodes.push(
      <pre key={`code-${nodes.length}`} className="my-3 rounded-xl bg-[var(--bg-1)] border border-[var(--border)] p-3 overflow-x-auto text-[11px] leading-relaxed">
        <code className="font-mono text-[var(--text-secondary)]" data-lang={language}>{code.join('\n')}</code>
      </pre>,
    );
  }
  flush();
  return <div className="text-[12.5px] leading-relaxed">{nodes}</div>;
}
