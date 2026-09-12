import { useMemo } from 'react';
import { useCodeChangesStore, useLanguageStore } from '../../stores';
import type { CodeChange } from '../../stores/codeChanges.store';

// Line-level diff via LCS — returns how many lines were added/removed.
function lineDiff(a: string, b: string): { added: number; removed: number } {
  const oldLines = a ? a.split('\n') : [];
  const newLines = b ? b.split('\n') : [];
  const m = oldLines.length, n = newLines.length;
  if (m * n > 4_000_000) return { added: n, removed: m }; // guard very large files
  const dp = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    let prev = 0;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = oldLines[i - 1] === newLines[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const lcs = dp[n];
  return { removed: m - lcs, added: n - lcs };
}

function statsFor(c: CodeChange): { added: number; removed: number } {
  if (c.kind === 'rename' || c.kind === 'copy') return { added: 0, removed: 0 };
  if (c.kind === 'delete') return { added: 0, removed: (c.originalCode || '').split('\n').filter(Boolean).length };
  return lineDiff(c.originalCode || '', c.newCode || ''); // edit / create
}

// Small floating pill above the input box summarizing the files the agent has
// edited this session and the total lines added/removed.
export default function DiffStatPill() {
  const changes = useCodeChangesStore((s) => s.changes);
  const { t } = useLanguageStore();

  const { files, added, removed } = useMemo(() => {
    const fileChanges = changes.filter(
      (c) => c.kind !== 'exec' && c.filePath !== '[Command]' && c.status !== 'reverted'
    );
    const seen = new Set<string>();
    let added = 0, removed = 0;
    for (const c of fileChanges) {
      const s = statsFor(c);
      added += s.added; removed += s.removed;
      seen.add(c.filePath);
    }
    return { files: seen.size, added, removed };
  }, [changes]);

  if (files === 0) return null;

  return (
    <div className="max-w-[900px] mx-auto w-full px-4 mb-2 flex justify-center">
      {/* Themed via variables, not literals: this floats over the chat in both
          light and dark, and a hardcoded dark chip stayed dark on cream. */}
      <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-medium shadow-lg
        bg-[var(--bg-2)] text-[var(--text-primary)] border border-[var(--border)]">
        <span>{files} {t('filesChanged')}</span>
        {added > 0 && <span className="text-[var(--success)]">+{added}</span>}
        {removed > 0 && <span className="text-[var(--error)]">-{removed}</span>}
      </div>
    </div>
  );
}
