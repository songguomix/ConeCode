import { useMemo, useState } from 'react';
import { FiChevronRight, FiLoader, FiCheck, FiTool } from 'react-icons/fi';
import { useBackgroundStore } from '../../stores/background.store';
import { useSkillsStore, useLanguageStore } from '../../stores';
import { findBuiltin } from '../../core/skills/builtin';

const TRIGGERS: Record<string, string> = {
  'todo-scan': 'Run it now on the open project.',
  'commit-msg': 'Run it now on the current working tree.',
  'repo-map': 'Run it now on the open project.',
};

/**
 * Generic view for read-only project plugins: install if missing, run in the
 * background with the skill instructions prefixed, jump to recent runs.
 */
export default function SkillRunView({ skillId }: { skillId: string }) {
  const body = useSkillsStore((s) => s.body);
  const install = useSkillsStore((s) => s.install);
  const launch = useBackgroundStore((s) => s.launch);
  const jump = useBackgroundStore((s) => s.jump);
  const tasks = useBackgroundStore((s) => s.tasks);
  const { t } = useLanguageStore();
  const [busy, setBusy] = useState(false);

  const catalog = findBuiltin(skillId);
  const skillBody = body(skillId);
  const runs = useMemo(
    () => Object.values(tasks).filter((task) => task.source === skillId).sort((a, b) => b.startedAt - a.startedAt),
    [tasks, skillId],
  );

  const run = async () => {
    if (!skillBody || busy) return;
    setBusy(true);
    try {
      await launch(
        `Skill "${skillId}" — follow these instructions for this task:\n\n${skillBody}\n\n${TRIGGERS[skillId] || 'Run it now.'}`,
        { title: catalog?.name || skillId, source: skillId },
      );
    } finally {
      setBusy(false);
    }
  };

  if (!skillBody) {
    return (
      <div className="px-3 py-4 text-center">
        <FiTool size={20} className="mx-auto mb-2 text-[var(--text-muted)]" />
        <p className="text-[13px] text-[var(--text-secondary)] mb-1">{catalog?.description}</p>
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
      <p className="px-1 mb-2 text-[13px] text-[var(--text-secondary)]">{catalog?.description}</p>
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
