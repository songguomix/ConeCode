import { useState, useEffect } from 'react';
import { FiEdit3, FiPause, FiPlay, FiTarget, FiTrash2, FiMaximize, FiMinimize, FiCheck } from 'react-icons/fi';
import { useChatStore, useGoalStore, useLanguageStore, useModelStore } from '../../stores';

import { goalElapsed } from '../../stores/goal.store';

export default function GoalProgressRow() {
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const isStreaming = useChatStore((s) => (activeConversationId ? !!s.streamingRuns[activeConversationId] : false));
  const stopGeneration = useChatStore((s) => s.stopGeneration);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const goal = useGoalStore((s) => activeConversationId ? s.goals[activeConversationId] : undefined);
  const setStatus = useGoalStore((s) => s.setStatus);
  const updateGoal = useGoalStore((s) => s.updateGoal);
  const clearGoal = useGoalStore((s) => s.clearGoal);
  const selectedModel = useModelStore((s) => s.getSelectedModel());
  const { t } = useLanguageStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (goal?.status !== 'running') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [goal?.status, goal?.createdAt]);

  if (!activeConversationId || !goal) return null;

  const pause = () => {
    setStatus(activeConversationId, 'paused');
    if (isStreaming) stopGeneration();
  };

  const resume = async () => {
    setStatus(activeConversationId, 'running');
    if (!isStreaming && selectedModel) {
      await sendMessage(t('goalResumePrompt'), selectedModel.providerId, selectedModel.id);
    }
  };

  const save = async () => {
    const text = draft.trim();
    if (!text) return;
    updateGoal(activeConversationId, text);
    setEditing(false);
    if (!isStreaming && selectedModel) {
      await sendMessage(`${t('goalUpdatedPrompt')} ${text}`, selectedModel.providerId, selectedModel.id);
    }
  };

  const clear = () => {
    if (isStreaming) stopGeneration();
    clearGoal(activeConversationId);
  };

  return (
    <div className="max-w-[900px] mx-auto w-full px-4 mb-1.5">
      <div className="flex items-center gap-2.5 px-3.5 py-2 rounded-2xl border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--glass-surface)_85%,transparent)] backdrop-blur-xl shadow-xs">
        <FiTarget size={14} className="text-[var(--accent)] shrink-0" />
        {editing ? (
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !(event.nativeEvent as any).isComposing) void save();
              if (event.key === 'Escape') setEditing(false);
            }}
            className="flex-1 min-w-0 bg-[var(--glass-card)] border border-[var(--accent)] rounded-xl px-2.5 py-1 text-xs outline-none"
            autoFocus
          />
        ) : (
          <div className="flex-1 min-w-0 flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--accent)] shrink-0">
              {goal.status === 'completed' ? t('goalCompleted') : goal.status === 'running' ? t('goalRunning') : t('goalPaused')}
            </span>
            <span className={`text-xs text-[var(--text-secondary)] ${expanded ? 'whitespace-pre-wrap break-words min-w-0' : 'truncate'}`} title={goal.text}>{goal.text}</span>
          </div>
        )}
        <div className="flex items-center gap-0.5 shrink-0">
          <span className="text-xs text-[var(--text-muted)] tabular-nums">{Math.floor(goalElapsed(goal, now) / 1000)}s</span>
          {editing ? (
            <button onClick={() => void save()} className="p-1.5 rounded-lg text-[var(--accent)] hover:bg-[var(--bg-3)] cursor-pointer transition-colors" title={t('save')}>
              <FiCheck size={12} />
            </button>
          ) : expanded && goal.status !== 'completed' && (
            <button onClick={() => { setDraft(goal.text); setEditing(true); }} className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-3)] cursor-pointer transition-colors" title={t('editGoal')}>
              <FiEdit3 size={12} />
            </button>
          )}
          {goal.status === 'running' ? (
            <button onClick={pause} className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-3)] cursor-pointer transition-colors" title={t('pauseGoal')}>
              <FiPause size={12} />
            </button>
          ) : goal.status === 'paused' && (
            <button disabled={!selectedModel || isStreaming} onClick={() => void resume()} className="p-1.5 rounded-lg text-[var(--accent)] hover:bg-[var(--bg-3)] cursor-pointer transition-colors" title={t('resumeGoal')}>
              <FiPlay size={12} />
            </button>
          )}
          <button onClick={clear} className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--bg-3)] cursor-pointer transition-colors" title={t('clearGoal')}>
            <FiTrash2 size={12} />
          </button>
          <button title={t('goalDetails')} aria-expanded={expanded} onClick={() => { setExpanded(!expanded); setEditing(false); }}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-3)]">
            {expanded ? <FiMinimize size={12} /> : <FiMaximize size={12} />}
          </button>
        </div>
      </div>
    </div>
  );
}
