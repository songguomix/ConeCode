import { memo, useEffect } from 'react';
import { FiRefreshCw } from 'react-icons/fi';
import { useChatStore, useLanguageStore } from '../../stores';
import MessageContent from './MessageContent';

export default memo(function StreamingReply({ conversationId, continues, onUpdate }: {
  conversationId: string;
  continues: boolean;
  onUpdate: () => void;
}) {
  const run = useChatStore((s) => s.streamingRuns[conversationId]);
  const { t } = useLanguageStore();
  const content = run?.content;
  const reasoning = run?.reasoningContent;

  useEffect(() => {
    if (content !== undefined) onUpdate();
  }, [content, reasoning, onUpdate]);

  if (!run) return null;
  const { retry, toolName, status } = run;
  return (
    <div className={continues ? 'mt-1.5' : 'mt-6'}>
      <div className="min-w-0">
        {retry && (
          <div className="mb-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[12px] font-medium text-[var(--warning)] anim-fade">
            <FiRefreshCw size={12} className="animate-spin shrink-0" />
            <span className="whitespace-nowrap">
              {retry.max != null
                ? `${t('streamRetry')} ${retry.attempt}/${retry.max}`
                : `${t('streamRetryEndless')} · ${retry.attempt}`}
            </span>
            <span className="flex items-center gap-0.5 pb-0.5">
              <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
          </div>
        )}
        {!retry && reasoning && (
          <details open className="mb-3 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-card)] px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-[var(--text-secondary)]">{t('thinkingProcess')}</summary>
            <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--text-secondary)]">{reasoning}</div>
          </details>
        )}
        {content
          ? <MessageContent content={content} streaming />
          : !retry && (
            <span className="text-[15px] text-[var(--text-muted)] anim-caret">
              {toolName
                ? `${t('callingTool')} ${toolName}...`
                : status === 'thinking' ? t('thinking') + '...' : '...'}
            </span>
          )}
      </div>
    </div>
  );
});
