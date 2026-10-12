import { useState, useRef, useEffect } from 'react';
import { FiHelpCircle, FiSend, FiLoader, FiAlertCircle } from 'react-icons/fi';
import { useChatStore, useLanguageStore, useModelStore } from '../../stores';
import type { Message } from '../../types/chat.types';

interface QuestionPromptCardProps {
  message: Message;
}

/**
 * Question Prompt Card
 *
 * Rendered directly above the chat input box with a solid opaque background.
 * Provides interactive options and a dedicated custom textarea to answer AI questions.
 * Unified visual design with CommandApprovalCard.
 */
export default function QuestionPromptCard({ message }: QuestionPromptCardProps) {
  const sendMessage = useChatStore((s) => s.sendMessage);
  const { t } = useLanguageStore();

  const [customAnswer, setCustomAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const compositionEndAtRef = useRef(0);

  // Auto-focus and auto-resize textarea
  useEffect(() => {
    textareaRef.current?.focus();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
    }
  }, []);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
    }
  }, [customAnswer]);

  const handleAnswer = async (answerText: string) => {
    const trimmed = answerText.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      // Resolve providerId/modelId from message or fallback to currently selected model
      const selectedModel = useModelStore.getState().getSelectedModel();
      const providerId = message.providerId || selectedModel?.providerId || '';
      const modelId = message.modelId || selectedModel?.id || '';
      if (!providerId || !modelId) {
        throw new Error(t('noModelSelected') || '未选择模型');
      }
      await sendMessage(trimmed, providerId, modelId);
      // Clear on success - the card will unmount when the question is answered
      setCustomAnswer('');
    } catch (e: any) {
      setError(e?.message || t('sendFailed') || '发送失败，请重试');
      // Keep the user's input on error so they can retry
    } finally {
      setSubmitting(false);
    }
  };

  const hasOptions = Array.isArray(message.questionOptions) && message.questionOptions.length > 0;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const native = e.nativeEvent as any;
    const justComposed = Date.now() - compositionEndAtRef.current < 250;
    if (composingRef.current || native.isComposing || native.keyCode === 229 || justComposed) {
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleAnswer(customAnswer);
    }
  };

  return (
    <div
      role="region"
      aria-label={t('aiAsking') || 'AI 正在提问'}
      className="w-full rounded-2xl border border-[var(--border)] bg-[var(--bg-2)] shadow-xl overflow-hidden outline-none select-text anim-slide-up"
      style={{ opacity: 1 }}
    >
      {/* Top Header Bar - fully opaque */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] bg-[var(--bg-1)]">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-[var(--accent-bg)] text-[var(--accent)] flex items-center justify-center shrink-0">
            <FiHelpCircle size={14} />
          </div>
          <h3 className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
            {t('aiAsking') || 'AI 正在提问'}
          </h3>
        </div>

        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--accent)] bg-[var(--accent-bg)] px-2.5 py-0.5 rounded-full border border-[var(--accent-border)] shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
          <span>{t('waitingForAnswer') || '等待回答'}</span>
        </span>
      </div>

      {/* Question Content & Interaction Body - fully opaque */}
      <div className="p-4 space-y-3.5 bg-[var(--bg-2)]">
        {/* Question Text */}
        <div className="text-[14px] text-[var(--text-primary)] font-medium leading-relaxed whitespace-pre-wrap max-h-[35vh] overflow-y-auto">
          {message.content}
        </div>

        {/* Predefined Quick Options (if present) */}
        {hasOptions && (
          <div className="space-y-1.5 pt-0.5">
            <div className="text-[11px] font-medium text-[var(--text-muted)] flex items-center gap-1">
              <span>{t('quickOptions') || '快捷选项：'}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {message.questionOptions!.map((option, index) => (
                <button
                  key={index}
                  onClick={() => void handleAnswer(option)}
                  disabled={submitting}
                  className="px-3.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--bg-1)] hover:bg-[var(--accent-bg)] hover:border-[var(--accent-border)] text-[var(--text-primary)] hover:text-[var(--accent)] text-[12.5px] font-medium transition-all shadow-2xs flex items-center gap-1.5 active:scale-[0.98] disabled:opacity-50 cursor-pointer"
                >
                  <span>{option}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Custom Input Field (支持用户自定义输入) - textarea with full opacity */}
        <div className="space-y-1.5 pt-1">
          {hasOptions && (
            <div className="text-[11px] font-medium text-[var(--text-muted)]">
              {t('orCustomAnswer') || '或输入自定义回答：'}
            </div>
          )}
          
          {/* Error display */}
          {error && (
            <div className="rounded-xl bg-[var(--error-bg)] border border-[var(--error-border)] px-3 py-2 text-[12px] text-[var(--error)] whitespace-pre-wrap flex items-start gap-2">
              <FiAlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-start gap-2">
            <textarea
              ref={textareaRef}
              value={customAnswer}
              onChange={(e) => setCustomAnswer(e.target.value)}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; compositionEndAtRef.current = Date.now(); }}
              placeholder={t('customAnswerPlaceholder') || '输入自定义回答，Enter 发送，Shift+Enter 换行…'}
              disabled={submitting}
              rows={2}
              className="flex-1 min-w-0 min-h-[56px] max-h-[160px] resize-none overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-1)] text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20 transition-all shadow-2xs px-3 py-2"
            />
            <button
              onClick={() => void handleAnswer(customAnswer)}
              disabled={!customAnswer.trim() || submitting}
              className="px-4 py-2 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12px] font-medium transition-colors disabled:opacity-40 flex items-center gap-1.5 shrink-0 shadow-xs self-start mt-1"
            >
              {submitting ? (
                <>
                  <FiLoader size={12} className="animate-spin" />
                  <span>{t('sending') || '发送中…'}</span>
                </>
              ) : (
                <>
                  <FiSend size={12} />
                  <span>{t('send') || '发送回答'}</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}