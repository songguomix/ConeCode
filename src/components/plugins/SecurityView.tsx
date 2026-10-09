import { useMemo, useState } from 'react';
import { FiChevronRight, FiLoader, FiCheck, FiShield } from 'react-icons/fi';
import { useBackgroundStore } from '../../stores/background.store';
import { useChatStore, useCodeChangesStore, useSkillsStore, useLanguageStore } from '../../stores';
import { findBuiltin } from '../../core/skills/builtin';

/**
 * Security review plugin view: pick the whole project or just the changed
 * files, run the read-only review in the background, jump to results.
 */
export default function SecurityView() {
  const changes = useCodeChangesStore((s) => s.changes);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const body = useSkillsStore((s) => s.body);
  const install = useSkillsStore((s) => s.install);
  const launch = useBackgroundStore((s) => s.launch);
  const jump = useBackgroundStore((s) => s.jump);
  const tasks = useBackgroundStore((s) => s.tasks);
  const { t } = useLanguageStore();
  const [mode, setMode] = useState<'project' | 'files'>('project');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const catalog = findBuiltin('security-review');
  const skillBody = body('security-review');
  const files = useMemo(() => {
    const seen = new Set<string>();
    for (const c of changes) {
      if (c.conversationId && c.conversationId !== activeConversationId) continue;
      if (!c.filePath || c.filePath.startsWith('[')) continue;
      seen.add(c.filePath);
    }
    return [...seen].sort();
  }, [changes, activeConversationId]);

  const effective = mode === 'files' && selected.length > 0 ? selected : null;
  const runs = useMemo(
    () => Object.values(tasks).filter((task) => task.source === 'security-review').sort((a, b) => b.startedAt - a.startedAt),
    [tasks],
  );

  const run = async () => {
    if (!skillBody || busy) return;
    setBusy(true);
    try {
      const target = mode === 'project' || !effective
        ? 'Scope: the whole open project.'
        : `Scope: these files only:\n${effective.map((f) => `- ${f}`).join('\n')}`;
      await launch(
        `Skill "security-review" — follow these instructions for this task:\n\n${skillBody}\n\n${target}`,
        { title: catalog?.name || 'Security Review', source: 'security-review' },
      );
    } finally {
      setBusy(false);
    }
  };

  if (!skillBody) {
    return (
      <div className="px-3 py-4 text-center">
        <FiShield size={20} className="mx-auto mb-2 text-[var(--text-muted)]" />
        <p className="text-[13px] text-[var(--text-secondary)] mb-3">{t('pluginNeedInstall')}</p>
        {catalog && (
          <button
            onClick={() => void install(catalog, 'global')}
            className="px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12px] font-medium hover:bg-[var(--accent-hover)] transition-colors"
          >
            {t('pluginInstall')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="px-2 py-1">
      <div className="flex gap-1.5 mb-2">
        {(['project', 'files'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            disabled={m === 'files' && files.length === 0}
            className={`flex-1 px-2 py-1.5 rounded-lg text-[12px] font-medium transition-colors disabled:opacity-40 ${
              mode === m
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'bg-[var(--bg-2)] text-[var(--text-secondary)] hover:bg-[var(--bg-3)]'
            }`}
          >
            {t(m === 'project' ? 'pluginTargetProject' : 'pluginTargetChanged')}
          </button>
        ))}
      </div>
      {mode === 'files' && (
        files.length === 0 ? (
          <p className="px-1 mb-2 text-[12px] text-[var(--text-muted)]">{t('pluginNoChanges')}</p>
        ) : (
          <div className="mb-2 max-h-[180px] overflow-y-auto rounded-xl bg-[var(--bg-2)] p-1">
            {files.map((f) => {
              const on = selected.includes(f);
              return (
                <button
                  key={f}
                  onClick={() => setSelected((s) => (on ? s.filter((x) => x !== f) : [...s, f]))}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg text-[12px] font-mono truncate transition-colors ${
                    on ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-3)]'
                  }`}
                >
                  {f}
                </button>
              );
            })}
          </div>
        )
      )}
      <button
        onClick={() => void run()}
        disabled={busy}
        className="w-full px-3 py-2 rounded-xl bg-[var(--accent)] text-white text-[13px] font-medium hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 mb-2"
      >
        {t('pluginRun')}
      </button>
      {runs.length > 0 && (
        <>
          <p className="px-1 mb-1 text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
            {t('pluginRecentRuns')}
          </p>
          {runs.slice(0, 5).map((task) => (
            <div key={task.conversationId} className="flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-[var(--bg-2)] transition-colors">
              {task.status === 'running' ? (
                <FiLoader size={12} className="text-[var(--accent)] animate-spin shrink-0" />
              ) : (
                <FiCheck size={12} className="text-[var(--success)] shrink-0" />
              )}
              <span className="flex-1 min-w-0 text-[12px] text-[var(--text-secondary)] truncate">
                {new Date(task.startedAt).toLocaleTimeString()} · {t(task.status === 'running' ? 'backgroundRunning' : 'backgroundDone')}
              </span>
              <button onClick={() => jump(task.conversationId)} title={t('backgroundJump')}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--bg-3)] transition-colors shrink-0">
                <FiChevronRight size={14} />
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
