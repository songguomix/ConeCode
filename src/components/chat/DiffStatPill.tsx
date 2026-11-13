import { useId, useMemo, useRef, useState } from 'react';
import { FiChevronDown, FiFileText, FiX } from 'react-icons/fi';
import { useLanguageStore } from '../../stores';
import type { CodeChange } from '../../stores/codeChanges.store';
import { buildDisplayDiff, countDisplayDiff } from '../../core/editor/displayDiff';
import DiffPreview from './DiffPreview';
import { useConversationChanges } from './useConversationChanges';

function fileText(change: CodeChange): [string, string] | null {
  if (change.kind === 'edit' || change.kind === 'create') return [change.originalCode, change.newCode];
  if (change.kind === 'delete' && change.originalCode !== '[Directory]') return [change.originalCode, ''];
  return null;
}

function FileDiff({ change }: { change: CodeChange }) {
  const { t } = useLanguageStore();
  const diff = useMemo(() => {
    const text = fileText(change);
    return text && buildDisplayDiff(...text);
  }, [change]);
  const status = change.status === 'failed' ? 'changeFailed' : change.status;

  return (
    <>
      <div className="border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--text-secondary)] [overflow-wrap:anywhere]">
        <p className="font-mono font-medium text-[var(--text-primary)]">{change.filePath}</p>
        <p className="mt-1">
          <span className={change.status === 'failed' ? 'text-[var(--error)]' : undefined}>{t(status)}</span>
          {' · '}{change.description}
        </p>
      </div>
      {diff && diff.lines.length > 0 ? (
        <DiffPreview lines={diff.lines} approximate={diff.approximate} label={change.filePath} className="min-h-0 flex-1" />
      ) : change.kind === 'rename' || change.kind === 'copy' ? (
        <div className="space-y-1 px-3 py-2 font-mono text-xs [overflow-wrap:anywhere]">
          <p>{change.originalCode}</p>
          <p>{change.newCode}</p>
        </div>
      ) : diff && <p className="px-3 py-2 text-xs text-[var(--text-muted)]">{t('noChanges')}</p>}
    </>
  );
}

export default function DiffStatPill() {
  const changes = useConversationChanges();
  const { t } = useLanguageStore();
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogId = useId();
  const [open, setOpen] = useState(false);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [changeId, setChangeId] = useState<string | null>(null);

  const { files, added, removed, approximate } = useMemo(() => {
    const files = new Map<string, CodeChange[]>();
    let added = 0;
    let removed = 0;
    let approximate = false;
    const visible = changes.filter(({ kind, status }) =>
      kind !== 'exec' && kind !== 'computer' && status !== 'reverted'
    ).sort((a, b) => b.createdAt - a.createdAt);
    for (const change of visible) {
      const revisions = files.get(change.filePath);
      if (revisions) revisions.push(change);
      else files.set(change.filePath, [change]);
      const text = fileText(change);
      if (!text) continue;
      const count = countDisplayDiff(...text);
      added += count.added;
      removed += count.removed;
      approximate ||= count.approximate;
    }
    return { files, added, removed, approximate };
  }, [changes]);

  if (files.size === 0 && !open) return null;
  const revisions = (filePath === null ? undefined : files.get(filePath)) ?? files.values().next().value;
  const selected = revisions?.find((change) => change.id === changeId) ?? revisions?.[0];

  return (
    <div className="mx-auto mb-2 flex w-full max-w-[900px] shrink-0 justify-center px-4">
      {files.size > 0 && (
        <button type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls={dialogId}
          onClick={() => {
            dialog.current!.showModal();
            setOpen(true);
          }}
          className="inline-flex cursor-pointer items-center gap-2.5 rounded-full border border-[var(--glass-border)] bg-[var(--glass-card)] px-4 py-1.5 text-xs font-medium text-[var(--text-primary)] shadow-sm transition-colors hover:bg-[var(--bg-3)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
          <FiFileText aria-hidden="true" size={13} className="text-[var(--text-muted)]" />
          <span>{files.size} {t('filesChanged')}</span>
          {(added > 0 || removed > 0) && (
            <span className="flex gap-2 tabular-nums" title={approximate ? t('diffApproximateCounts') : undefined}>
              {added > 0 && <span className="font-semibold text-[var(--success)]">{approximate ? '≈' : ''}+{added}</span>}
              {removed > 0 && <span className="font-semibold text-[var(--error)]">{approximate ? '≈' : ''}−{removed}</span>}
            </span>
          )}
          <FiChevronDown aria-hidden="true" size={13} className="text-[var(--text-muted)]" />
        </button>
      )}
      <dialog ref={dialog} id={dialogId} aria-label={t('changedFiles')}
        onClose={() => setOpen(false)}
        onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}
        className="m-auto w-[min(760px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-2)] text-[var(--text-primary)] shadow-2xl backdrop:bg-black/35">
        {open && (
          <div className="flex h-[min(520px,80dvh)] min-w-0 flex-col">
            <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-2">
              <h2 className="text-sm font-semibold">{t('changedFiles')} <span className="ml-1 text-xs text-[var(--text-muted)]">{files.size}</span></h2>
              <form method="dialog">
                <button aria-label={t('close')} className="cursor-pointer rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-3)]">
                  <FiX size={16} />
                </button>
              </form>
            </div>
            {selected && revisions ? (
              <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
                <ul className="max-h-28 shrink-0 overflow-y-auto border-b border-[var(--border)] p-1.5 sm:max-h-none sm:w-52 sm:border-b-0 sm:border-r">
                  {[...files.keys()].map((path) => (
                    <li key={path}>
                      <button type="button" title={path} aria-current={path === selected.filePath ? 'true' : undefined}
                        onClick={() => { setFilePath(path); setChangeId(null); }}
                        className="block w-full cursor-pointer rounded-lg px-2 py-1.5 text-left hover:bg-[var(--bg-3)] aria-[current=true]:bg-[var(--accent-soft)]">
                        <span className="block truncate text-xs font-medium">{path.split(/[/\\]/).pop()}</span>
                        <span className="block truncate text-[10px] text-[var(--text-muted)]">{path}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  {revisions.length > 1 && (
                    <select aria-label={t('aboutVersion')} value={selected.id} onChange={(event) => setChangeId(event.target.value)}
                      className="mx-3 my-2 min-w-0 shrink-0 rounded-md border border-[var(--border)] bg-[var(--bg-2)] px-2 py-1 text-xs">
                      {revisions.map((change, index) => (
                        <option key={change.id} value={change.id}>{revisions.length - index} · {new Date(change.createdAt).toLocaleTimeString()} · {change.description}</option>
                      ))}
                    </select>
                  )}
                  <FileDiff change={selected} />
                </div>
              </div>
            ) : <p className="p-4 text-sm text-[var(--text-muted)]">{t('noChanges')}</p>}
          </div>
        )}
      </dialog>
    </div>
  );
}
