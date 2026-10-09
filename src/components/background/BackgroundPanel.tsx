import { FiX, FiChevronRight, FiClock, FiCheck, FiLoader } from 'react-icons/fi';
import { useBackgroundStore } from '../../stores/background.store';
import { useChatStore, useUIStore, useLanguageStore } from '../../stores';

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

/**
 * OpenCode-style background tasks: runs dispatched from the composer keep
 * going while the user chats elsewhere. Finished-unseen tasks badge the
 * sidebar entry; jump opens the conversation, × cancels/removes.
 */
export default function BackgroundPanel() {
  const tasks = useBackgroundStore((s) => s.tasks);
  const jump = useBackgroundStore((s) => s.jump);
  const remove = useBackgroundStore((s) => s.remove);
  const closeBackground = useUIStore((s) => s.closeBackground);
  const stopGeneration = useChatStore((s) => s.stopGeneration);
  const { t } = useLanguageStore();

  const list = Object.values(tasks).sort((a, b) => b.startedAt - a.startedAt);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={closeBackground} />
      <div className="fixed left-4 bottom-4 top-[96px] z-50 w-[420px] max-w-[calc(100vw-2rem)] flex flex-col bg-[var(--bg-1)] border border-[var(--border)] rounded-2xl shadow-2xl overflow-hidden anim-menu">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)] shrink-0">
          <FiClock size={14} className="text-[var(--accent)] shrink-0" />
          <span className="text-sm font-medium text-[var(--text-primary)] flex-1 truncate">
            {t('backgroundTasks')}
          </span>
          <span className="text-[11px] text-[var(--text-muted)]">{list.length}</span>
          <button onClick={closeBackground} aria-label={t('screenshotCancel')}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--bg-3)] transition-colors">
            <FiX size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 min-h-0">
          {list.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
              {t('backgroundEmpty')}
            </p>
          )}
          {list.map((task) => (
            <div key={task.conversationId}
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl transition-colors ${
                task.unseen ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-2)]'
              }`}>
              {task.status === 'running' ? (
                <FiLoader size={13} className="text-[var(--accent)] animate-spin shrink-0" />
              ) : (
                <FiCheck size={13} className="text-[var(--success)] shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-[var(--text-primary)] truncate">{task.title}</p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  {t(task.status === 'running' ? 'backgroundRunning' : 'backgroundDone')}
                  {' · '}
                  {ago(task.status === 'running' ? task.startedAt : task.finishedAt ?? task.startedAt)}
                  {task.unseen ? ` · ${t('backgroundUnseen')}` : ''}
                </p>
              </div>
              <button
                onClick={() => jump(task.conversationId)}
                title={t('backgroundJump')}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--bg-3)] hover:text-[var(--text-primary)] transition-colors shrink-0"
              >
                <FiChevronRight size={14} />
              </button>
              <button
                onClick={() => {
                  if (task.status === 'running') stopGeneration(task.conversationId);
                  remove(task.conversationId);
                }}
                title={t('screenshotCancel')}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--bg-3)] transition-colors shrink-0"
              >
                <FiX size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
