import { useState } from 'react';
import { FiCopy, FiCornerDownRight, FiMoreHorizontal, FiRotateCw, FiTrash2 } from 'react-icons/fi';
import { useChatStore, useLanguageStore } from '../../stores';

const actionClass = 'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[var(--text-muted)] hover:bg-[var(--bg-3)] hover:text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed';

export default function QueuedMessages({ conversationId }: { conversationId: string }) {
  const messages = useChatStore((s) => s.queuedMessages[conversationId]);
  const isRunning = useChatStore((s) => Boolean(s.streamingRuns[conversationId]));
  const flush = useChatStore((s) => s.flushQueue);
  const steer = useChatStore((s) => s.steerQueuedMessage);
  const remove = useChatStore((s) => s.dequeueMessage);
  const { t } = useLanguageStore();
  const [openId, setOpenId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'copied' | 'failed' | null>(null);

  if (!messages?.length) return null;
  const selected = messages.find((message) => message.id === openId);
  const next = messages.find((m) => m.steer) ?? messages.find((m) => !m.steerError);

  return (
    <section aria-label={t('queuedTag')} className="mx-3 -mb-2 rounded-t-[18px] border border-b-0 border-[var(--glass-border)] bg-[var(--glass-surface)] pb-2">
      <ol className="max-h-36 overflow-y-auto divide-y divide-[var(--glass-border)]">
        {messages.map((message) => (
          <li key={message.id} className="px-2.5 py-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-[var(--text-muted)]">
                <path d="M2 3v7a2 2 0 0 0 2 2h9m-2-2 2 2-2 2M5 3h6M5 6h4" />
              </svg>
              {!!message.images?.length && (
                <div className="flex shrink-0 items-center gap-1">
                  <img src={message.images[0]} alt={t('queuedImage')} loading="lazy" className="h-7 w-7 rounded object-cover" />
                  {message.images.length > 1 && <span className="text-xs text-[var(--text-muted)]">+{message.images.length - 1}</span>}
                </div>
              )}
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--text-primary)]">{message.content}</span>
              {!isRunning && message.deliveryError && next?.id === message.id ? (
                <button type="button" onClick={() => void flush(conversationId)} className={actionClass}>
                  <FiRotateCw size={14} aria-hidden="true" /><span className="text-xs">{t('queueRetry')}</span>
                </button>
              ) : <button type="button" onClick={() => steer(conversationId, message.id)} disabled={!isRunning || message.steer}
                title={t('queueSteerHint')} className={actionClass}>
                <FiCornerDownRight size={14} aria-hidden="true" />
                <span className="text-xs">{t(message.steer ? 'queueSteering' : 'queueSteer')}</span>
              </button>}
              <button type="button" onClick={() => remove(conversationId, message.id)}
                aria-label={t('queueRemove')} title={t('queueRemove')} className={`${actionClass} hover:text-[var(--error)]`}>
                <FiTrash2 size={14} aria-hidden="true" />
              </button>
              <button type="button" aria-expanded={openId === message.id}
                aria-label={t('queueDetails')} title={t('queueDetails')} className={actionClass}
                onClick={() => { setOpenId((id) => id === message.id ? null : message.id); setCopyState(null); }}>
                <FiMoreHorizontal size={15} aria-hidden="true" />
              </button>
            </div>
            {(message.steerError || message.deliveryError) && (
              <p role="alert" className="truncate pl-[22px] text-xs text-[var(--error)]" title={message.steerError || message.deliveryError}>
                {message.steerError || message.deliveryError}
              </p>
            )}
          </li>
        ))}
      </ol>
      {selected && (
        <div className="border-t border-[var(--glass-border)] px-3 py-2">
          {!!selected.images?.length && (
            <div className="flex gap-2 overflow-x-auto py-1">
              {selected.images.map((src, i) => <img key={i} src={src} alt={`${t('queuedImage')} ${i + 1}`} loading="lazy" className="h-16 rounded object-contain" />)}
            </div>
          )}
          {selected.content && <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-xs text-[var(--text-secondary)]">{selected.content}</p>}
          {selected.content && <button type="button" className={`${actionClass} mt-1 text-xs`} onClick={async () => {
            try {
              await navigator.clipboard.writeText(selected.content);
              setCopyState('copied');
            } catch {
              setCopyState('failed');
            }
          }}>
            <FiCopy size={12} aria-hidden="true" /> {t('copy')}
          </button>}
          {copyState && <span role="status" className="ml-1 text-xs text-[var(--text-muted)]">{t(copyState === 'copied' ? 'copied' : 'queueCopyFailed')}</span>}
        </div>
      )}
    </section>
  );
}
