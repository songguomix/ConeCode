import { useState } from 'react';
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
  const createRsiConversation = useChatStore((s) => s.createRsiConversation);
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const getSelectedModel = useModelStore((s) => s.getSelectedModel);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [creating, setCreating] = useState(false);

  const rsiConversations = conversations.filter((c) => isRsiConversation(c));

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const model = getSelectedModel();
      await createRsiConversation(model?.providerId || '', model?.id || '');
    } finally {
      setCreating(false);
    }
  };

  const handleRename = (id: string) => {
    const title = editTitle.trim();
    if (title) void renameConversation(id, title);
    setEditingId(null);
  };

  const handleDelete = (conv: Conversation) => {
    if (!window.confirm(t('deleteConfirm').replace('{name}', conv.title))) return;
    void deleteConversation(conv.id);
  };

  return (
    <aside className="w-56 shrink-0 flex flex-col min-h-0 border-r border-[var(--glass-border)] bg-[var(--glass-surface)]/60 backdrop-blur-2xl">
      <div className="flex items-center justify-between gap-1.5 px-3 pt-4 pb-3 border-b border-[var(--glass-border)]/70 min-w-0">
        <span className="text-[12px] font-bold uppercase tracking-wide text-[var(--text-muted)] font-serif truncate min-w-0 flex-1">
          {t('rsiConvList')}
        </span>
        <button
          onClick={() => void handleCreate()}
          disabled={creating}
          title={t('rsiConvNew')}
          className="w-8 h-8 rounded-xl flex items-center justify-center bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white transition-colors disabled:opacity-50 shrink-0"
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
              onClick={() => editingId !== conv.id && void setActiveConversation(conv.id)}
              className={`group flex items-center gap-2 px-2.5 py-1.5 rounded-xl cursor-pointer text-[12.5px] transition-all min-w-0 ${
                activeConversationId === conv.id
                  ? 'bg-[var(--glass-card)]/85 backdrop-blur-md text-[var(--text-primary)] font-medium shadow-xs border border-[var(--glass-border)] ring-1 ring-[var(--accent)]/20'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--glass-card)]/50 hover:text-[var(--text-primary)] border border-transparent'
              }`}
            >
              {editingId === conv.id ? (
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={() => handleRename(conv.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) handleRename(conv.id);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  className="flex-1 min-w-0 bg-[var(--bg-2)] border border-[var(--accent)] rounded-lg px-2 py-0.5 text-[12.5px] outline-none"
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <div className="flex-1 min-w-0">
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
                </div>
              )}
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
                <button
                  onClick={(e) => { e.stopPropagation(); setEditingId(conv.id); setEditTitle(conv.title); }}
                  title={t('rename')}
                  className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-4)]"
                >
                  <FiEdit3 size={11} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(conv); }}
                  title={t('delete')}
                  className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--bg-4)]"
                >
                  <FiTrash2 size={11} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
