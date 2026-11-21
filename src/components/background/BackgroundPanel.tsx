import { memo, useCallback, useMemo } from 'react';
import { FiX, FiChevronRight, FiClock } from 'react-icons/fi';
import { useBackgroundStore, type BackgroundTask } from '../../stores/background.store';
import { useUIStore, useLanguageStore } from '../../stores';
import { BackgroundTaskStatusIcon, backgroundTaskStatusKey } from './backgroundTaskPresentation';

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

const BackgroundTaskRow = memo(function BackgroundTaskRow({ task, age, jump, remove }: {
  task: BackgroundTask;
  age: string;
  jump: (id: string) => void;
  remove: (id: string) => void;
}) {
  const { t } = useLanguageStore();
  return (
    <div className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-transparent transition-colors [content-visibility:auto] [contain-intrinsic-height:auto_36px] ${
      task.unseen ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-2)]'
    }`}>
      <BackgroundTaskStatusIcon task={task} size={13} />
      <div className="flex-1 min-w-0">
        <p className="text-[13px] text-[var(--text-primary)] truncate">{task.title}</p>
        <p className="text-[11px] text-[var(--text-muted)]">
          {t(backgroundTaskStatusKey(task))}
          {' · '}{age}
          {task.unseen ? ` · ${t('backgroundUnseen')}` : ''}
        </p>
      </div>
      <button
        onClick={() => jump(task.conversationId)}
        title={t('backgroundJump')}
        className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--bg-3)] hover:text-[var(--text-primary)] transition-colors shrink-0 cursor-pointer"
      >
        <FiChevronRight size={14} />
      </button>
      <button
        onClick={() => remove(task.conversationId)}
        title={t(task.status === 'running' || task.status === 'waiting' ? 'cancel' : 'backgroundRemove')}
        className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--bg-3)] transition-colors shrink-0 cursor-pointer"
      >
        <FiX size={13} />
      </button>
    </div>
  );
});

/**
 * Lists detached conversations from the Panels menu. Opening a conversation
 * also closes this overlay so the transcript is visible immediately.
 */
export default function BackgroundPanel() {
  const tasks = useBackgroundStore((s) => s.tasks);
  const jump = useBackgroundStore((s) => s.jump);
  const remove = useBackgroundStore((s) => s.remove);
  const closeBackground = useUIStore((s) => s.closeBackground);
  const { t } = useLanguageStore();

  const list = useMemo(() => Object.values(tasks).sort((a, b) => b.startedAt - a.startedAt), [tasks]);
  const openConversation = useCallback((id: string) => {
    jump(id);
    closeBackground();
  }, [jump, closeBackground]);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-xs" onClick={closeBackground} />
      <div className="fixed left-4 bottom-4 top-[96px] z-50 w-[420px] max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-112px)] flex flex-col bg-[var(--glass-surface)] backdrop-blur-2xl border border-[var(--glass-border)] rounded-2xl shadow-2xl overflow-hidden anim-menu ring-1 ring-black/5 dark:ring-white/10">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--glass-border)] shrink-0">
          <FiClock size={14} className="text-[var(--accent)] shrink-0" />
          <span className="text-[13.5px] font-serif font-bold text-[var(--text-primary)] flex-1 truncate tracking-tight">
            {t('backgroundTasks')}
          </span>
          <span className="text-[11px] text-[var(--text-muted)]">{list.length}</span>
          <button onClick={closeBackground} aria-label={t('close')}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--bg-3)] transition-colors cursor-pointer">
            <FiX size={14} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2.5">
          {list.length === 0 && (
            <p className="rounded-xl border border-dashed border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-1)_50%,transparent)] px-4 py-5 text-center text-xs leading-relaxed text-[var(--text-muted)]">
              {t('backgroundEmpty')}
            </p>
          )}
          {list.map((task) => (
            <BackgroundTaskRow
              key={task.conversationId}
              task={task}
              age={ago(task.finishedAt ?? task.startedAt)}
              jump={openConversation}
              remove={remove}
            />
          ))}
        </div>
      </div>
    </>
  );
}
