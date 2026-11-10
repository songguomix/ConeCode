import { useEffect, useState } from 'react';
import {
  FiAlertCircle,
  FiEdit3,
  FiExternalLink,
  FiGitPullRequest,
  FiMessageSquare,
  FiRefreshCw,
  FiSend,
} from 'react-icons/fi';
import { useLanguageStore } from '../../stores/language.store';
import { loadGithubToken, useMarketStore } from '../../stores/market.store';
import { useGithubReplyStore } from '../../stores/githubReply.store';
import type { ReplyLanguage } from '../../types/githubReply.types';

/**
 * The GitHub plugin's reply assistant tab.
 *
 * Shares the plugin's owner/repo and token, lists open issues/PRs through the
 * main process, generates an editable local draft, and posts only after an
 * explicit confirmation step. Webhook automation stays in the separate
 * self-hosted service; this tab is the in-app, manual workflow.
 */
export default function ReplyAssistantView({ onConfigureRepo }: { onConfigureRepo?: () => void }) {
  const repo = useMarketStore((s) => s.repo);
  const tokenSet = useMarketStore((s) => s.tokenSet);
  const { t } = useLanguageStore();
  const {
    language,
    threads,
    loadingList,
    listError,
    selectedNumber,
    context,
    loadingContext,
    contextError,
    draft,
    posting,
    postResult,
    setLanguage,
    loadThreads,
    selectThread,
    setDraft,
    regenerateDraft,
    post,
    reset,
  } = useGithubReplyStore();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!repo.trim()) {
      reset();
      return;
    }
    void loadThreads(repo, loadGithubToken() ?? '');
    // tokenSet changes when a token is saved in the push tab.
  }, [repo, tokenSet, loadThreads, reset]);

  if (!repo.trim()) {
    return (
      <div className="px-3 py-3 rounded-xl bg-[var(--bg-2)] border border-[var(--border)] min-w-0">
        <p className="text-[12px] font-medium text-[var(--text-primary)] mb-1">{t('replyAssistantNeedRepo')}</p>
        <p className="text-[11px] leading-relaxed text-[var(--text-muted)] mb-2">{t('replyAssistantNeedRepoHint')}</p>
        {onConfigureRepo && (
          <button
            onClick={onConfigureRepo}
            className="px-3 py-1.5 rounded-lg bg-[var(--bg-3)] text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-4)] transition-colors cursor-pointer"
          >
            {t('replyAssistantConfigure')}
          </button>
        )}
      </div>
    );
  }

  const token = loadGithubToken() ?? '';

  const refresh = () => {
    setConfirming(false);
    void loadThreads(repo, token);
  };

  const choose = (number: number) => {
    setConfirming(false);
    void selectThread(number, repo, token);
  };

  const confirmPost = async () => {
    const ok = await post(repo, token);
    setConfirming(false);
    if (ok) void loadThreads(repo, token);
  };

  return (
    <div className="min-w-0">
      <div className="flex items-start justify-between gap-2 mb-2 px-1">
        <div className="min-w-0">
          <p className="text-[12px] font-medium text-[var(--text-primary)]">{t('replyAssistantTitle')}</p>
          <p className="text-[11px] leading-relaxed text-[var(--text-muted)] break-words [overflow-wrap:anywhere]">
            {t('replyAssistantSubtitle')}
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loadingList}
          title={t('replyAssistantRefresh')}
          aria-label={t('replyAssistantRefresh')}
          className="px-2.5 py-1.5 rounded-lg bg-[var(--bg-3)] text-[var(--text-secondary)] hover:bg-[var(--bg-4)] transition-colors disabled:opacity-50 shrink-0 cursor-pointer disabled:cursor-not-allowed"
        >
          <FiRefreshCw size={12} className={loadingList ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex items-center gap-2 mb-2 px-1">
        <label className="text-[11px] text-[var(--text-muted)]">{t('replyAssistantLanguage')}</label>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value as ReplyLanguage)}
          className="px-2 py-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] text-[11.5px] outline-none cursor-pointer"
        >
          <option value="auto">{t('replyAssistantLangAuto')}</option>
          <option value="zh">{t('replyAssistantLangZh')}</option>
          <option value="en">{t('replyAssistantLangEn')}</option>
        </select>
      </div>

      <p className="px-1 mb-1 text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
        {t('replyAssistantOpenThreads')}
      </p>
      {loadingList ? (
        <p className="px-2 py-3 text-[12px] text-[var(--text-muted)]">{t('replyAssistantLoading')}</p>
      ) : listError ? (
        <div className="mb-2 px-3 py-2 rounded-xl bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[12px] text-[var(--error)] break-words [overflow-wrap:anywhere]">
          <span className="inline-flex items-start gap-1.5">
            <FiAlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{listError}</span>
          </span>
        </div>
      ) : threads.length === 0 ? (
        <p className="px-2 py-3 text-[12px] text-[var(--text-muted)]">{t('replyAssistantEmpty')}</p>
      ) : (
        <ul className="mb-2 max-h-56 overflow-y-auto rounded-xl border border-[var(--border)] divide-y divide-[var(--border)]">
          {threads.map((thread) => {
            const active = selectedNumber === thread.number;
            return (
              <li key={thread.number}>
                <button
                  onClick={() => choose(thread.number)}
                  aria-pressed={active}
                  className={`w-full text-left px-2.5 py-2 transition-colors cursor-pointer ${
                    active ? 'bg-[var(--bg-3)]' : 'hover:bg-[var(--bg-2)]'
                  }`}
                >
                  <span className="flex items-center gap-1.5 mb-0.5 min-w-0">
                    <span
                      className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        thread.isPullRequest
                          ? 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]'
                          : 'bg-[var(--bg-4)] text-[var(--text-secondary)]'
                      }`}
                    >
                      {thread.isPullRequest ? (
                        <FiGitPullRequest size={10} aria-hidden="true" />
                      ) : (
                        <FiMessageSquare size={10} aria-hidden="true" />
                      )}
                      {thread.isPullRequest ? t('replyAssistantPullRequest') : t('replyAssistantIssue')}
                    </span>
                    <span className="shrink-0 text-[11px] text-[var(--text-muted)]">#{thread.number}</span>
                    <span className="truncate text-[12px] text-[var(--text-primary)]">{thread.title}</span>
                  </span>
                  <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10.5px] text-[var(--text-muted)]">
                    <span>{thread.author}</span>
                    {thread.labels.slice(0, 3).map((label) => (
                      <span key={label}>#{label}</span>
                    ))}
                    <span>
                      {thread.comments} {t('replyAssistantComments')}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selectedNumber === null ? (
        <p className="px-2 py-2 mb-2 text-[11.5px] text-[var(--text-muted)]">{t('replyAssistantSelect')}</p>
      ) : loadingContext ? (
        <p className="px-2 py-3 text-[12px] text-[var(--text-muted)]">{t('replyAssistantLoading')}</p>
      ) : contextError ? (
        <p className="mb-2 px-3 py-2 rounded-xl bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[12px] text-[var(--error)] break-words [overflow-wrap:anywhere]">
          {contextError}
        </p>
      ) : context ? (
        <>
          <div className="mb-2 rounded-xl border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2 min-w-0">
            <div className="flex items-start justify-between gap-2 mb-1">
              <p className="text-[12px] font-medium text-[var(--text-primary)] break-words [overflow-wrap:anywhere]">
                {context.title}
              </p>
              <a
                href={context.url}
                target="_blank"
                rel="noopener noreferrer"
                title={t('replyAssistantViewOnGithub')}
                aria-label={t('replyAssistantViewOnGithub')}
                className="shrink-0 text-[var(--text-muted)] hover:text-[var(--accent)]"
              >
                <FiExternalLink size={12} />
              </a>
            </div>
            <p className="text-[11px] text-[var(--text-muted)] mb-1">
              {context.author} · #{context.number} · {context.state}
            </p>
            <p className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-[var(--text-secondary)] max-h-32 overflow-y-auto break-words [overflow-wrap:anywhere]">
              {context.body || '—'}
            </p>
            {context.recentComments.length > 0 && (
              <div className="mt-2 pt-2 border-t border-[var(--border)]">
                <p className="text-[10.5px] uppercase tracking-wider text-[var(--text-muted)] mb-1">
                  {t('replyAssistantRecentComments')}
                </p>
                <ul className="space-y-1">
                  {context.recentComments.slice(-3).map((comment) => (
                    <li
                      key={comment.id}
                      className="text-[11px] leading-relaxed text-[var(--text-secondary)] break-words [overflow-wrap:anywhere]"
                    >
                      <span className="text-[var(--text-muted)]">{comment.author}:</span>{' '}
                      {comment.body.length > 240 ? `${comment.body.slice(0, 240)}…` : comment.body}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 mb-1 px-1">
            <label className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
              <FiEdit3 size={11} aria-hidden="true" />
              {t('replyAssistantDraft')}
            </label>
            <div className="flex items-center gap-2">
              <span className="text-[10.5px] text-[var(--text-muted)]">
                {draft.length}/4000 {t('replyAssistantChars')}
              </span>
              <button
                onClick={() => {
                  setConfirming(false);
                  regenerateDraft();
                }}
                className="px-2 py-1 rounded-lg bg-[var(--bg-3)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-4)] transition-colors cursor-pointer"
              >
                {t('replyAssistantRegenerate')}
              </button>
            </div>
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={7}
            maxLength={4000}
            disabled={posting}
            spellCheck={false}
            aria-label={t('replyAssistantDraft')}
            className="w-full px-2.5 py-2 mb-1 rounded-xl bg-[var(--bg-2)] border border-[var(--border)] text-[12px] leading-relaxed outline-none focus:border-[color-mix(in_srgb,var(--accent)_50%,transparent)] resize-y disabled:opacity-60"
          />
          <p className="px-1 mb-2 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
            {t('replyAssistantDraftHint')}
          </p>

          {!tokenSet && (
            <p className="px-2 py-2 mb-2 rounded-xl bg-[var(--bg-2)] border border-[var(--border)] text-[11px] text-[var(--text-muted)]">
              {t('replyAssistantTokenHint')}
            </p>
          )}

          {confirming ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2.5 mb-2">
              <p className="text-[11.5px] text-[var(--text-secondary)] mb-2">{t('replyAssistantConfirm')}</p>
              <div className="flex gap-1.5">
                <button
                  onClick={() => void confirmPost()}
                  disabled={posting}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12px] font-medium hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                >
                  {posting ? t('replyAssistantPosting') : t('replyAssistantConfirmPost')}
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  disabled={posting}
                  className="px-3 py-1.5 rounded-lg bg-[var(--bg-3)] text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-4)] transition-colors disabled:opacity-50 cursor-pointer"
                >
                  {t('replyAssistantCancel')}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              disabled={!tokenSet || !draft.trim() || posting}
              className="w-full mb-2 px-3 py-2 rounded-xl bg-[var(--accent)] text-white text-[13px] font-medium hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5 cursor-pointer disabled:cursor-not-allowed"
            >
              <FiSend size={13} />
              {posting ? t('replyAssistantPosting') : t('replyAssistantPost')}
            </button>
          )}

          {postResult && (
            <p
              className={`px-3 py-2 mb-2 rounded-xl text-[12px] break-words [overflow-wrap:anywhere] ${
                postResult.ok
                  ? 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]'
                  : 'bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error)]'
              }`}
            >
              {postResult.ok ? `${t('replyAssistantPosted')} · ${postResult.message}` : postResult.message}
              {postResult.ok && postResult.url && (
                <a
                  href={postResult.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1.5 inline-flex items-center gap-1 underline"
                >
                  {t('replyAssistantViewOnGithub')}
                  <FiExternalLink size={11} aria-hidden="true" />
                </a>
              )}
            </p>
          )}
        </>
      ) : null}

      <p className="px-1 mt-2 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
        {t('replyAssistantAutomationHint')}
      </p>
    </div>
  );
}
