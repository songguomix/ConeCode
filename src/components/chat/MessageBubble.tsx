import { memo, useState, useRef, useEffect } from 'react';
import type { Message } from '../../types';
import { FiCopy, FiCheck, FiRotateCcw, FiChevronDown, FiChevronRight, FiHelpCircle, FiClock, FiZap } from 'react-icons/fi';
import { useChatStore, useModelStore, useLanguageStore, useSettingsStore } from '../../stores';
import MessageContent from './MessageContent';

/**
 * Memoized: historical rows must not re-parse markdown every time a stream
 * token lands. Props that change (editing, continuation) stay explicit.
 */
function MessageBubble({
  message,
  isContinuation = false,
  dimmed = false,
  editing = false,
  onEdit,
  onCancelEdit,
}: {
  message: Message;
  isContinuation?: boolean;
  // Folded into a summary: still readable, visibly out of the model's context.
  dimmed?: boolean;
  editing?: boolean;
  onEdit?: (id: string) => void;
  onCancelEdit?: () => void;
}) {
  const isToolResult = message.isToolResult;
  const isUser = message.role === 'user' && !isToolResult;
  const isQuestion = message.isQuestion;
  const [expanded, setExpanded] = useState(false);
  const [showCopied, setShowCopied] = useState(false);
  const [answered, setAnswered] = useState(false);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const editMessage = useChatStore((s) => s.editMessage);
  const saving = useChatStore((s) => !!s.messageEdits[message.conversationId]);
  const selectedModel = useModelStore((s) => s.getSelectedModel());
  const sendWithEnter = useSettingsStore((s) => s.sendWithEnter);
  const [draft, setDraft] = useState(message.content);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const compositionEndAtRef = useRef(0);
  const getSelectedModel = useModelStore((s) => s.getSelectedModel);
  const { t } = useLanguageStore();

  useEffect(() => {
    if (!editing) return;
    setDraft(message.content);
    editorRef.current?.focus();
    editorRef.current?.setSelectionRange(message.content.length, message.content.length);
  }, [editing, message.content]);

  useEffect(() => {
    const el = editorRef.current;
    if (!el || !editing) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 64), 300)}px`;
  }, [draft, editing]);

  const formatThinkingTime = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  };

  const topMargin = (isContinuation ? 'mt-1.5' : 'mt-6') + (dimmed ? ' opacity-45' : '');

  if (isToolResult) {
    const preview = message.content.split('\n')[0].replace(/^Result for /, '').slice(0, 80);
    return (
      <div className={`${topMargin}`}>
        <div className="min-w-0">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            {expanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
            <span className="font-mono truncate">{expanded ? t('toolResult') : preview}</span>
          </button>
          {expanded && (
            <pre className="mt-1.5 text-xs font-mono whitespace-pre-wrap bg-[var(--bg-2)] border border-[var(--border)] rounded-xl p-3.5 overflow-x-auto text-[var(--text-secondary)] max-h-80 overflow-y-auto">
              {message.content}
            </pre>
          )}
        </div>
      </div>
    );
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content);
    setShowCopied(true);
    setTimeout(() => setShowCopied(false), 1500);
  };

  const handleEdit = () => {
    if (!isUser || saving) return;
    onEdit?.(message.id);
  };

  const handleSubmitEdit = () => {
    if (!selectedModel || !draft.trim() || saving) return;
    void editMessage(message.id, draft, selectedModel.providerId, selectedModel.id);
  };

  const handleAnswer = async (answer: string) => {
    if (answered) return;
    setAnswered(true);
    const providerId = message.providerId || getSelectedModel()?.providerId || '';
    const modelId = message.modelId || getSelectedModel()?.id || '';
    if (!providerId || !modelId) return;
    await sendMessage(answer, providerId, modelId);
  };

  return (
    <div className={`group ${topMargin}`}>
      {isUser && editing ? (
        <div className="w-full rounded-3xl bg-[var(--bg-3)] p-4">
          <textarea
            ref={editorRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('editMessagePlaceholder')}
            aria-label={t('editMessagePlaceholder')}
            disabled={saving}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; compositionEndAtRef.current = Date.now(); }}
            onKeyDown={(e) => {
              if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229 ||
                  Date.now() - compositionEndAtRef.current < 250) return;
              if (e.key === 'Escape' && !saving) { e.preventDefault(); onCancelEdit?.(); }
              if (e.key === 'Enter' && !e.shiftKey && (sendWithEnter || e.metaKey || e.ctrlKey)) {
                e.preventDefault(); handleSubmitEdit();
              }
            }}
            className="block w-full min-h-16 resize-none bg-transparent text-[15px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
          />
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={onCancelEdit} disabled={saving}
              className="px-4 py-2 rounded-xl bg-[var(--bg-0)] border border-[var(--border)] text-sm text-[var(--text-primary)] disabled:opacity-50">
              {t('cancel')}
            </button>
            <button onClick={handleSubmitEdit} disabled={saving || !draft.trim() || !selectedModel}
              className="px-4 py-2 rounded-xl bg-[var(--text-primary)] text-[var(--bg-0)] text-sm disabled:opacity-40">
              {t('send')}
            </button>
          </div>
        </div>
      ) : isUser ? (
        <div className="flex justify-end">
          <div className="flex flex-col items-end gap-1 max-w-[85%]">
            <div className="rounded-2xl px-4 py-2.5 text-[15px] whitespace-pre-wrap bg-[var(--bg-3)] text-[var(--text-primary)]">
              {message.content}
            </div>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button onClick={handleCopy} title={t('copy')}
                className="p-1 rounded-lg hover:bg-[var(--bg-3)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors">
                {showCopied ? <FiCheck size={12} className="text-[var(--success)]" /> : <FiCopy size={12} />}
              </button>
              <button onClick={handleEdit} title={t('edit')} aria-label={t('edit')} disabled={saving}
                className="p-1 rounded-lg hover:bg-[var(--bg-3)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors">
                <FiRotateCcw size={12} />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div>
          <div className="flex flex-col gap-1 min-w-0">
            {isQuestion ? (
              <div className="max-w-[90%] rounded-xl p-4 text-[15px] bg-[var(--bg-2)] border border-[var(--border)] border-l-2 border-l-[var(--accent)]">
                <div className="text-[var(--accent)] text-xs font-semibold mb-2 flex items-center gap-1.5">
                  <FiHelpCircle size={13} /> {t('aiAsking')}
                </div>
                <div className="whitespace-pre-wrap text-[var(--text-primary)]">{message.content}</div>
                {message.questionOptions && !answered && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {message.questionOptions.map((option, index) => (
                      <button key={index} onClick={() => handleAnswer(option)}
                        className="px-3.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--bg-0)] text-[var(--text-primary)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors text-sm font-medium">
                        {option}
                      </button>
                    ))}
                  </div>
                )}
                {!message.questionOptions && !answered && (
                  <div className="mt-3 text-xs text-[var(--text-muted)]">{t('typeAnswerHint')}</div>
                )}
                {answered && <div className="mt-2 text-xs font-medium text-[var(--success)] flex items-center gap-1"><FiCheck size={12} /> {t('answered')}</div>}
              </div>
            ) : (
              <div className="min-w-0 w-full">
                <MessageContent content={message.content} toolCalls={message.toolCalls} />
              </div>
            )}

            <div className="flex items-center justify-between mt-1">
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={handleCopy} title={t('copy')}
                  className="p-1 rounded-lg hover:bg-[var(--bg-3)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors">
                  {showCopied ? <FiCheck size={12} className="text-[var(--success)]" /> : <FiCopy size={12} />}
                </button>
              </div>
              {(message.thinkingTime != null || message.tokensUsed != null) && (
                <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                  {message.thinkingTime != null && (
                    <span className="flex items-center gap-1"><FiClock size={11} />{formatThinkingTime(message.thinkingTime)}</span>
                  )}
                  {message.tokensUsed != null && (
                    <span className="flex items-center gap-1"><FiZap size={11} />{message.tokensUsed} {t('tokens')}</span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(MessageBubble);
