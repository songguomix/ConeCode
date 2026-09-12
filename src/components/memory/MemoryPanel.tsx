import { useEffect, useState } from 'react';
import { FiTrash2, FiCpu, FiMessageSquare, FiAlertCircle, FiPlus, FiGitBranch, FiFolder } from 'react-icons/fi';
import { useMemoryStore, useWorkspaceStore } from '../../stores';
import { MEMORY_KINDS, type MemoryKind, type MemoryEntry } from '../../core/memory/memory';

const KIND_META: Record<MemoryKind, { icon: JSX.Element; labelKey: string; tone: string }> = {
  workflow: { icon: <FiGitBranch size={11} />, labelKey: 'memoryWorkflow', tone: 'text-[var(--accent)]' },
  project: { icon: <FiFolder size={11} />, labelKey: 'memoryProject', tone: 'text-[var(--success)]' },
  codeIssue: { icon: <FiAlertCircle size={11} />, labelKey: 'memoryCodeIssue', tone: 'text-[var(--warning)]' },
  style: { icon: <FiMessageSquare size={11} />, labelKey: 'memoryStyle', tone: 'text-blue-500' },
  fact: { icon: <FiCpu size={11} />, labelKey: 'memoryFact', tone: 'text-[var(--text-muted)]' },
};

/**
 * Everything the agent has learned, shown plainly so it can be corrected.
 * Memory that can't be inspected or deleted is memory you can't trust — and
 * since workflow rules change what the assistant *does*, they lead, with the
 * reason each one was learned visible underneath.
 */
export default function MemoryPanel({ t }: { t: (k: string) => string }) {
  const entries = useMemoryStore((s) => s.entries);
  const enabled = useMemoryStore((s) => s.enabled);
  const setEnabled = useMemoryStore((s) => s.setEnabled);
  const load = useMemoryStore((s) => s.load);
  const remove = useMemoryStore((s) => s.remove);
  const clear = useMemoryStore((s) => s.clear);
  const add = useMemoryStore((s) => s.add);
  const loaded = useMemoryStore((s) => s.loaded);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const [draft, setDraft] = useState('');
  const [draftKind, setDraftKind] = useState<MemoryKind>('workflow');
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);

  const submit = async () => {
    if (!draft.trim()) return;
    await add(draft, draftKind, draftKind === 'project' ? rootPath : null);
    setDraft('');
  };

  const projectName = rootPath ? rootPath.split('/').pop() : null;
  // Memories belonging to a *different* project are hidden — they don't apply
  // here and would only be noise.
  const visible = entries.filter((e) => e.scope === 'global' || !rootPath || e.projectPath === rootPath);
  const byKind = (kind: MemoryKind) => visible
    .filter((e) => e.kind === kind)
    .sort((a, b) => b.hits - a.hits || b.updatedAt - a.updatedAt);

  return (
    <div className="bg-[var(--bg-2)] border border-[var(--border)] rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <div className="font-medium text-sm">{t('memory')}</div>
        <span className="text-xs text-[var(--text-muted)]">({visible.length})</span>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-[var(--text-secondary)] cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-[var(--accent)]" />
          {t('memoryEnabled')}
        </label>
      </div>
      <p className="text-xs text-[var(--text-muted)] mb-3">{t('memoryHint')}</p>

      <div className="flex items-center gap-2 mb-3">
        <select
          value={draftKind}
          onChange={(e) => setDraftKind(e.target.value as MemoryKind)}
          className="shrink-0 px-2 py-1.5 rounded-lg bg-[var(--bg-3)] border border-[var(--border)] text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        >
          {MEMORY_KINDS.map((kind) => (
            <option key={kind} value={kind}>{t(KIND_META[kind].labelKey)}</option>
          ))}
        </select>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) void submit(); }}
          placeholder={draftKind === 'project' ? t('memoryAddProjectPlaceholder') : t('memoryAddPlaceholder')}
          className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-[var(--bg-3)] border border-[var(--border)] text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
        <button onClick={submit} disabled={!draft.trim()}
          className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[var(--accent)] text-white text-xs hover:bg-[var(--accent-hover)] disabled:opacity-40">
          <FiPlus size={12} /> {t('memoryAdd')}
        </button>
      </div>
      {draftKind === 'project' && !rootPath && (
        <p className="text-[11px] text-[var(--warning)] -mt-1 mb-2">{t('memoryProjectNeedsFolder')}</p>
      )}

      {visible.length === 0 ? (
        <div className="text-xs text-[var(--text-muted)] py-2">{t('memoryEmpty')}</div>
      ) : (
        <div className="space-y-3 max-h-80 overflow-y-auto">
          {MEMORY_KINDS.map((kind) => {
            const group = byKind(kind);
            if (!group.length) return null;
            const meta = KIND_META[kind];
            return (
              <section key={kind}>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className={meta.tone}>{meta.icon}</span>
                  <span className="text-[11px] font-medium text-[var(--text-secondary)]">{t(meta.labelKey)}</span>
                  {kind === 'project' && projectName && (
                    <span className="text-[10px] text-[var(--text-muted)]">· {projectName}</span>
                  )}
                  <span className="text-[10px] text-[var(--text-muted)]">{group.length}</span>
                </div>
                <ul className="space-y-1">
                  {group.map((entry) => <Row key={entry.id} entry={entry} t={t} onForget={() => remove(entry.id)} />)}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {visible.length > 0 && (
        <div className="mt-3 flex items-center gap-2">
          {confirmClear ? (
            <>
              <span className="text-xs text-[var(--text-muted)]">{t('memoryClearConfirm')}</span>
              <button onClick={async () => { await clear(); setConfirmClear(false); }}
                className="px-2 py-1 rounded-lg bg-[var(--error)]/15 text-xs font-semibold text-[var(--error)] hover:bg-[var(--error)]/25">
                {t('memoryClear')}
              </button>
              <button onClick={() => setConfirmClear(false)}
                className="px-2 py-1 rounded-lg bg-[var(--bg-3)] text-xs text-[var(--text-secondary)]">
                {t('cancel')}
              </button>
            </>
          ) : (
            <button onClick={() => setConfirmClear(true)}
              className="text-xs text-[var(--text-muted)] hover:text-[var(--error)] transition-colors">
              {t('memoryClear')}
            </button>
          )}
          {rootPath && <span className="ml-auto text-[10px] text-[var(--text-muted)] truncate">{rootPath}</span>}
        </div>
      )}
    </div>
  );
}

function Row({ entry, t, onForget }: { entry: MemoryEntry; t: (k: string) => string; onForget: () => void }) {
  return (
    <li className="group flex items-start gap-2 text-xs">
      <span className="mt-1 w-1 h-1 rounded-full bg-[var(--text-muted)] shrink-0" />
      <span className="flex-1 min-w-0 leading-snug">
        <span className="text-[var(--text-secondary)]">{entry.text}</span>
        {entry.hits > 1 && <span className="ml-1.5 text-[10px] text-[var(--text-muted)]">×{entry.hits}</span>}
        {/* The reason is what makes a rule reviewable — without it you can't tell
            a lesson worth keeping from one the assistant over-generalised. */}
        {entry.why && (
          <span className="block text-[11px] text-[var(--text-muted)] italic mt-0.5">{t('memoryLearned')}: {entry.why}</span>
        )}
      </span>
      <button onClick={onForget} title={t('memoryForget')}
        className="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--error)] transition-all">
        <FiTrash2 size={11} />
      </button>
    </li>
  );
}
