import { useMemo, useRef, useState } from 'react';
import { FiEdit3, FiLoader, FiPlus, FiTrash2 } from 'react-icons/fi';
import { useChatStore } from '../../stores/chat.store';
import { useLanguageStore } from '../../stores/language.store';
import { useModelStore } from '../../stores/model.store';
import { isRsiConversation, type RsiConversationStatus } from '../../core/agents/rsiConversation';
import type { Conversation } from '../../types';

const STATUS_DOT: Record<RsiConversationStatus, string> = {
  running: 'bg-[var(--accent)] animate-pulse',
  failed: 'bg-[var(--error)]',
  completed: 'bg-[var(--success)]',
  idle: 'bg-[var(--border)]',
};

const STATUS_LABEL: Record<RsiConversationStatus, string> = {
  running: 'rsiRunning',
  failed: 'rsiConvStatusFailed',
  completed: 'rsiConvStatusCompleted',
  idle: 'rsiIdle',
};

/** Compact absolute timestamp: today shows the clock, older shows the date. */
function shortTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * Left pane of the RSI view: the conversation history. Conversations listed
 * here are real persisted records (agentMode 'rsi' + their own direction and
 * run state), identified by stable ids — never by list position.
 */
export default function RsiConversationList() {
  const { t } = useLanguageStore();
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const newRsiConversation = useChatStore((s) => s.newRsiConversation);
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const getSelectedModel = useModelStore((s) => s.getSelectedModel);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const editingRef = useRef<string | null>(null);

  const rsiConversations = useMemo(() => conversations.filter(isRsiConversation)
    .sort((a, b) => b.updatedAt - a.updatedAt), [conversations]);
  const reportError = (error: unknown) => setError(error instanceof Error ? error.message : t('rsiOperationFailed'));

  const handleCreate = async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setError(null);
    try {
      const model = getSelectedModel();
      await newRsiConversation(model?.providerId || '', model?.id || '');
    } catch (error) {
      reportError(error);
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const handleRename = (id: string) => {
    if (editingRef.current !== id) return;
    editingRef.current = null;
    const title = editTitle.trim();
    if (title) void renameConversation(id, title).catch(reportError);
    setEditingId(null);
  };

  const handleDelete = (conv: Conversation) => {
    if (!window.confirm(t('deleteConfirm').replace('{name}', conv.title))) return;
    void deleteConversation(conv.id).catch(reportError);
  };

  return (
    <aside aria-label={t('rsiConvList')} className="w-48 xl:w-56 shrink-0 flex flex-col min-h-0 border-r border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-surface)_60%,transparent)] backdrop-blur-2xl">
      <div className="flex items-center justify-between gap-1.5 px-3 pt-4 pb-3 border-b border-[color-mix(in_srgb,var(--glass-border)_70%,transparent)] min-w-0">
        <span className="text-[12px] font-bold uppercase tracking-wide text-[var(--text-muted)] font-serif truncate min-w-0 flex-1">
          {t('rsiConvList')}
        </span>
        <button
          onClick={() => void handleCreate()}
          disabled={creating}
          title={t('rsiConvNew')}
          aria-label={t('rsiConvNew')}
          className="w-8 h-8 rounded-xl flex items-center justify-center bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white transition-colors disabled:opacity-50 shrink-0 cursor-pointer disabled:cursor-not-allowed"
        >
          {creating ? <FiLoader size={15} className="animate-spin" /> : <FiPlus size={15} />}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5 min-h-0">
        {rsiConversations.length === 0 ? (
          <div className="px-2 py-6 text-center min-w-0">
            <p className="text-[12px] text-[var(--text-muted)] leading-relaxed break-words [overflow-wrap:anywhere]">{t('rsiConvEmpty')}</p>
          </div>
        ) : (
          rsiConversations.map((conv) => (
            <div
              key={conv.id}
              className={`group flex items-center gap-2 px-2.5 py-1.5 rounded-xl cursor-pointer text-[12.5px] transition-all min-w-0 ${
                activeConversationId === conv.id
                  ? 'bg-[color-mix(in_srgb,var(--glass-card)_85%,transparent)] backdrop-blur-md text-[var(--text-primary)] font-medium shadow-xs border border-[var(--glass-border)] ring-1 ring-[color-mix(in_srgb,var(--accent)_20%,transparent)]'
                  : 'text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--glass-card)_50%,transparent)] hover:text-[var(--text-primary)] border border-transparent'
              }`}
            >
              {editingId === conv.id ? (
                <input
                  value={editTitle}
                  aria-label={t('rename')}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={() => handleRename(conv.id)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === 'Enter') handleRename(conv.id);
                    if (e.key === 'Escape') { editingRef.current = null; setEditingId(null); }
                  }}
                  className="flex-1 min-w-0 bg-[var(--bg-2)] border border-[var(--accent)] rounded-lg px-2 py-0.5 text-[12.5px] outline-none"
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => void setActiveConversation(conv.id).catch(reportError)}
                  aria-current={activeConversationId === conv.id ? 'true' : undefined}
                  className="flex-1 min-w-0 text-left rounded-md outline-offset-2"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={`shrink-0 w-1.5 h-1.5 rounded-full ${STATUS_DOT[conv.rsi?.status ?? 'idle']}`}
                      title={t(STATUS_LABEL[conv.rsi?.status ?? 'idle'])}
                    />
                    <span className="truncate block flex-1 min-w-0" title={conv.title}>{conv.title}</span>
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)] mt-0.5 truncate">
                    {shortTime(conv.updatedAt)}
                  </div>
                </button>
              )}
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity shrink-0">
                <button
                  onClick={() => { editingRef.current = conv.id; setEditingId(conv.id); setEditTitle(conv.title); }}
                  title={t('rename')}
                  aria-label={`${t('rename')}: ${conv.title}`}
                  className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-4)] cursor-pointer transition-colors"
                >
                  <FiEdit3 size={11} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(conv); }}
                  title={t('delete')}
                  aria-label={`${t('delete')}: ${conv.title}`}
                  className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--bg-4)] cursor-pointer transition-colors"
                >
                  <FiTrash2 size={11} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      {error && <p role="alert" className="px-3 py-2 text-xs text-[var(--error)] break-words [overflow-wrap:anywhere]">{error}</p>}
    </aside>
  );
}
