import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { FiArrowLeft, FiChevronRight, FiMessageSquare, FiUsers, FiX } from 'react-icons/fi';
import { useChatStore, useLanguageStore, useUIStore } from '../../stores';
import { useSubAgentHistory } from '../../stores/subAgents.store';
import type { SubAgentRun } from '../../types/subAgent.types';
import MessageContent from '../chat/MessageContent';

const statusLabels: Record<SubAgentRun['status'], string> = {
  running: 'backgroundRunning',
  completed: 'backgroundDone',
  failed: 'changeFailed',
  interrupted: 'subAgentInterrupted',
  limit: 'subAgentLimit',
};

const statusDots: Record<SubAgentRun['status'], string> = {
  running: 'bg-[var(--accent)] animate-pulse',
  completed: 'bg-[var(--success)]',
  failed: 'bg-[var(--error)]',
  interrupted: 'bg-[var(--warning)]',
  limit: 'bg-[var(--warning)]',
};

function RunStatus({ status }: { status: SubAgentRun['status'] }) {
  const { t } = useLanguageStore();
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDots[status]}`} />
      {t(statusLabels[status])}
    </span>
  );
}

const TranscriptEntry = memo(function TranscriptEntry({ message }: { message: SubAgentRun['messages'][number] }) {
  const { t } = useLanguageStore();
  return message.role === 'tool' ? (
    <details className="rounded-lg border border-[var(--glass-border)] bg-[var(--bg-1)] px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-[var(--text-secondary)]">
        {t('toolResult')}{message.name && <code className="ml-2">{message.name}</code>}
      </summary>
      <pre className="mt-2 whitespace-pre-wrap font-mono text-xs leading-relaxed">{message.content}</pre>
    </details>
  ) : (
    <div>
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
        <FiUsers size={13} aria-hidden="true" />{t('subAgent')}
      </h3>
      <MessageContent content={message.content} toolCalls={message.toolCalls} />
    </div>
  );
});

const Transcript = memo(function Transcript({ run }: { run: SubAgentRun }) {
  const { t } = useLanguageStore();
  return (
    <div className="space-y-4 p-4 text-[var(--text-primary)] [overflow-wrap:anywhere] select-text">
      <section className="rounded-xl border border-[var(--glass-border)] bg-[var(--glass-card)] p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-[var(--text-secondary)]">{t('subAgentTask')}</h3>
          <RunStatus status={run.status} />
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{run.task}</p>
      </section>
      {run.messages.map((message, index) => <TranscriptEntry key={index} message={message} />)}
      {run.detail && <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--text-secondary)]">{run.detail}</p>}
    </div>
  );
});

const RunRow = memo(function RunRow({ id, task, startedAt, status, time, select }: Pick<SubAgentRun, 'id' | 'task' | 'startedAt' | 'status'> & {
  time: Intl.DateTimeFormat;
  select: (id: string) => void;
}) {
  return (
    <li className="[content-visibility:auto] [contain-intrinsic-height:auto_80px]">
      <button type="button" onClick={() => select(id)} title={task}
        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-2)]">
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-sm font-medium text-[var(--text-primary)] [overflow-wrap:anywhere]">{task}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <RunStatus status={status} />
            <time className="text-[11px] text-[var(--text-muted)]">{time.format(startedAt)}</time>
          </span>
        </span>
        <FiChevronRight size={14} className="shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
      </button>
    </li>
  );
});

export default function SubAgentPanel() {
  const { t, locale } = useLanguageStore();
  const close = useUIStore((s) => s.closeSubAgents);
  const conversations = useChatStore((s) => s.conversations);
  const { runs, loading, error, reload } = useSubAgentHistory();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => { dialog.current?.showModal(); }, []);

  const titles = useMemo(() => new Map(conversations.map((c) => [c.id, c.title])), [conversations]);
  const selected = selectedId === null ? undefined : runs.find((run) => run.id === selectedId && titles.has(run.conversationId));
  const showingList = !selected;
  const groups = useMemo(() => {
    const byConversation = new Map<string, SubAgentRun[]>();
    if (!showingList) return byConversation;
    for (const run of [...runs].sort((a, b) => b.startedAt - a.startedAt)) {
      if (!titles.has(run.conversationId)) continue;
      const existing = byConversation.get(run.conversationId);
      if (existing) existing.push(run);
      else byConversation.set(run.conversationId, [run]);
    }
    return byConversation;
  }, [runs, titles, showingList]);
  const time = useMemo(() => new Intl.DateTimeFormat(locale === 'zhHant' ? 'zh-Hant' : locale, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }), [locale]);

  return (
    <dialog ref={dialog} aria-label={t('subAgents')} onClose={close}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}
      className="fixed bottom-auto left-4 right-auto top-[96px] m-0 h-[calc(100dvh-112px)] max-h-none w-[520px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-surface)] p-0 shadow-2xl backdrop-blur-2xl backdrop:bg-black/20 backdrop:backdrop-blur-xs">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-[var(--glass-border)] px-4 py-3">
          {selected ? (
            <button type="button" onClick={() => setSelectedId(null)} aria-label={t('pluginBack')} title={t('pluginBack')}
              className="cursor-pointer rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-3)]">
              <FiArrowLeft size={16} />
            </button>
          ) : <FiUsers size={16} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />}
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-serif text-sm font-bold text-[var(--text-primary)]">{t('subAgents')}</h2>
            {selected && <p className="truncate text-xs text-[var(--text-muted)]">{titles.get(selected.conversationId)}</p>}
          </div>
          <button type="button" onClick={close} aria-label={t('close')} title={t('close')}
            className="cursor-pointer rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-3)]">
            <FiX size={16} />
          </button>
        </header>
        {error && (
          <div role="alert" className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--text-secondary)]">
            {t('subAgentLoadError')}
            <button type="button" onClick={reload} disabled={loading} className="shrink-0 cursor-pointer text-[var(--accent)] disabled:opacity-50">{t('updateErrorRetry')}</button>
          </div>
        )}
        <div key={selected?.id ?? 'list'} className="min-h-0 flex-1 overflow-y-auto">
          {selected ? <Transcript run={selected} /> : (
            <div className="space-y-4 p-3">
              {groups.size === 0 && (loading || !error) && (
                <p role="status" className="rounded-xl border border-dashed border-[var(--border)] px-4 py-5 text-center text-xs leading-relaxed text-[var(--text-muted)]">
                  {t(loading ? 'replyAssistantLoading' : 'subAgentEmpty')}
                </p>
              )}
              {Array.from(groups, ([conversationId, children]) => (
                <section key={conversationId}>
                  <h3 className="mb-1 flex items-center gap-2 px-2 text-xs font-medium text-[var(--text-secondary)]">
                    <FiMessageSquare size={13} aria-hidden="true" className="shrink-0" />
                    <span className="truncate" title={titles.get(conversationId)}>{titles.get(conversationId)}</span>
                  </h3>
                  <ul>{children.map((run) => (
                    <RunRow key={run.id} id={run.id} status={run.status} task={run.task} startedAt={run.startedAt} time={time} select={setSelectedId} />
                  ))}</ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}
