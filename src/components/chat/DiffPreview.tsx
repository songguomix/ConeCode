import { useEffect, useRef } from 'react';
import type { DisplayDiffLine } from '../../core/editor/displayDiff';
import { useLanguageStore } from '../../stores/language.store';

export default function DiffPreview({
  lines,
  label,
  approximate,
  className = 'max-h-56',
}: {
  lines: readonly DisplayDiffLine[];
  label?: string;
  approximate: boolean;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const t = useLanguageStore((state) => state.t);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const firstChange = lines.findIndex((line) => line.type !== 'unchanged');
    if (firstChange <= 0) {
      container.scrollTop = 0;
      return;
    }
    // Wrapped context rows may be taller than the viewport.
    const row = container.children[firstChange] as HTMLElement;
    const context = container.children[Math.max(0, firstChange - 2)] as HTMLElement;
    container.scrollTop = Math.max(context.offsetTop, row.offsetTop - container.clientHeight / 2);
  }, [lines]);

  return (
    <div className="flex min-w-0 min-h-0 flex-1 flex-col">
      {approximate && (
        <p className="shrink-0 border-b border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-secondary)]">
          {t('diffApproximate')}
        </p>
      )}
      <div ref={scrollRef} dir="ltr" role={label ? 'region' : undefined} aria-label={label} tabIndex={0}
        className={`relative min-w-0 min-h-0 overflow-y-auto overflow-x-hidden text-xs leading-5 font-mono ${className}`}>
        {lines.map((line, index) => (
          <div key={index} className={`grid grid-cols-[4ch_4ch_2ch_minmax(0,1fr)] sm:grid-cols-[5ch_5ch_2.5ch_minmax(0,1fr)] ${
            line.type === 'added' ? 'bg-green-500/15 dark:bg-green-500/10' :
            line.type === 'removed' ? 'bg-red-500/15 dark:bg-red-500/10' : ''
          }`}>
            <span aria-hidden="true" className="pr-1 text-right tabular-nums text-[var(--text-muted)] select-none">{line.oldLine}</span>
            <span aria-hidden="true" className="pr-1 text-right tabular-nums text-[var(--text-muted)] select-none">{line.newLine}</span>
            <span aria-hidden="true" className={`text-center select-none ${
              line.type === 'added' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
            }`}>
              {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ''}
            </span>
            <code className="min-w-0 pl-1 pr-3 whitespace-break-spaces [overflow-wrap:anywhere] [tab-size:4]">{line.content}</code>
          </div>
        ))}
      </div>
    </div>
  );
}
