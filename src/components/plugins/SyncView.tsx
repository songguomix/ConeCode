import { useEffect, useState } from 'react';
import { FiRefreshCw, FiKey, FiUpload } from 'react-icons/fi';
import { useMarketStore } from '../../stores/market.store';
import { useLanguageStore, useWorkspaceStore } from '../../stores';

/**
 * GitHub plugin view. This plugin pushes the *open project* to GitHub: point it
 * at an "owner/repo", optionally drop a token for private repos, and push. The
 * commit+push runs through the main process — no SKILL.md scanning, no plugin
 * market. The chat model drives the same store method (pushRepo) as a tool.
 */
export default function SyncView() {
  const repo = useMarketStore((s) => s.repo);
  const setRepo = useMarketStore((s) => s.setRepo);
  const tokenSet = useMarketStore((s) => s.tokenSet);
  const setToken = useMarketStore((s) => s.setToken);
  const status = useMarketStore((s) => s.status);
  const refreshing = useMarketStore((s) => s.refreshing);
  const pushing = useMarketStore((s) => s.pushing);
  const result = useMarketStore((s) => s.result);
  const lastPushAt = useMarketStore((s) => s.lastPushAt);
  const refresh = useMarketStore((s) => s.refresh);
  const pushRepo = useMarketStore((s) => s.pushRepo);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const { t } = useLanguageStore();
  const [repoDraft, setRepoDraft] = useState(repo);
  const [tokenDraft, setTokenDraft] = useState('');

  // Show the open project's git state as soon as a folder is chosen.
  useEffect(() => {
    void refresh();
  }, [refresh, rootPath]);

  const canPush = !!rootPath && !pushing;

  return (
    <div className="px-2 py-1">
      <label className="block px-1 mb-1 text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
        {t('pluginRepoLabel')}
      </label>
      <div className="flex gap-1.5 mb-1">
        <input
          value={repoDraft}
          onChange={(e) => setRepoDraft(e.target.value)}
          onBlur={() => setRepo(repoDraft)}
          placeholder={t('pluginRepoPh')}
          spellCheck={false}
          className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] text-[13px] outline-none focus:border-[var(--accent)]/50"
        />
        <button
          onClick={() => void refresh()}
          disabled={refreshing}
          title={t('pluginRefresh')}
          className="px-2.5 py-1.5 rounded-lg bg-[var(--bg-3)] text-[var(--text-secondary)] hover:bg-[var(--bg-4)] transition-colors disabled:opacity-50 shrink-0"
        >
          <FiRefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>
      <p className="px-1 mb-2 text-[11px] text-[var(--text-muted)]">{t('pluginRepoHint')}</p>

      <label className="block px-1 mb-1 text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
        {t('pluginTokenLabel')}
      </label>
      <div className="flex gap-1.5 mb-2">
        <div className="relative flex-1 min-w-0">
          <FiKey size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            type="password"
            placeholder={tokenSet ? t('pluginTokenSet') : t('pluginTokenPh')}
            spellCheck={false}
            autoComplete="off"
            className="w-full pl-8 pr-2.5 py-1.5 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] text-[13px] outline-none focus:border-[var(--accent)]/50"
          />
        </div>
        <button
          onClick={() => { setToken(tokenDraft.trim() || null); setTokenDraft(''); }}
          className="px-3 py-1.5 rounded-lg bg-[var(--bg-3)] text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-4)] transition-colors shrink-0"
        >
          {t('pluginSave')}
        </button>
        {tokenSet && (
          <button
            onClick={() => { setToken(null); setTokenDraft(''); }}
            className="px-3 py-1.5 rounded-lg text-[12px] text-[var(--text-muted)] hover:text-[var(--error)] transition-colors shrink-0"
          >
            {t('pluginClearToken')}
          </button>
        )}
      </div>

      {/* What will be pushed: the open project's branch and uncommitted count. */}
      <div className="px-3 py-2 mb-2 rounded-xl bg-[var(--bg-2)] border border-[var(--border)]">
        {!rootPath ? (
          <p className="text-[12px] text-[var(--text-muted)]">{t('pluginNoProject')}</p>
        ) : status && !status.isRepo ? (
          <p className="text-[12px] text-[var(--text-muted)]">{t('pluginNotGit')}</p>
        ) : status ? (
          <p className="text-[12px] text-[var(--text-secondary)]">
            {t('pluginBranch')}: <span className="text-[var(--text-primary)]">{status.branch}</span>
            {' · '}
            {status.dirty > 0 ? `${status.dirty} ${t('pluginChanges')}` : t('pluginClean')}
          </p>
        ) : (
          <p className="text-[12px] text-[var(--text-muted)]">{t('pluginChecking')}</p>
        )}
      </div>

      <button
        onClick={() => { setRepo(repoDraft); void pushRepo(); }}
        disabled={!canPush}
        className="w-full mb-2 px-3 py-2 rounded-xl bg-[var(--accent)] text-white text-[13px] font-medium hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
      >
        <FiUpload size={13} />
        {pushing ? t('pluginPushing') : t('pluginPushProject')}
      </button>

      {result && (
        <p className={`px-3 py-2 mb-2 rounded-xl text-[12px] ${
          result.ok
            ? 'bg-[var(--success)]/10 text-[var(--success)]'
            : 'bg-[var(--error)]/10 text-[var(--error)]'
        }`}>
          {result.message}
        </p>
      )}
      {lastPushAt && (
        <p className="px-1 text-[11px] text-[var(--text-muted)]">
          {t('pluginLastPush')}: {new Date(lastPushAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}
