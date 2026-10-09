import { useState } from 'react';
import { FiRefreshCw, FiDownload, FiKey, FiUpload } from 'react-icons/fi';
import { useMarketStore } from '../../stores/market.store';
import { useSkillsStore, useLanguageStore, useWorkspaceStore } from '../../stores';

const ERR_KEYS: Record<string, string> = {
  'repo-not-found': 'pluginErrRepo',
  'auth-failed': 'pluginErrAuth',
  'rate-limited': 'pluginErrRate',
  'network-error': 'pluginErrNet',
  'empty-repo': 'pluginErrEmpty',
  'conflict': 'pluginErrConflict',
};

/**
 * GitHub plugin source: owner/repo + optional token (private repos, higher
 * rate limits). Sync scans **\/SKILL.md and installs through the unreviewed
 * custom path. The token lives only in localStorage, never in state.
 */
export default function SyncView() {
  const repo = useMarketStore((s) => s.repo);
  const setRepo = useMarketStore((s) => s.setRepo);
  const tokenSet = useMarketStore((s) => s.tokenSet);
  const setToken = useMarketStore((s) => s.setToken);
  const remote = useMarketStore((s) => s.remote);
  const fetchedAt = useMarketStore((s) => s.fetchedAt);
  const syncing = useMarketStore((s) => s.syncing);
  const error = useMarketStore((s) => s.error);
  const sync = useMarketStore((s) => s.sync);
  const installRemote = useMarketStore((s) => s.installRemote);
  const origins = useMarketStore((s) => s.origins);
  const pushing = useMarketStore((s) => s.pushing);
  const pushSkill = useMarketStore((s) => s.pushSkill);
  const hasLocalChanges = useMarketStore((s) => s.hasLocalChanges);
  const installedSkills = useSkillsStore((s) => s.installed);
  const isInstalled = useSkillsStore((s) => s.isInstalled);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const { t } = useLanguageStore();
  const [repoDraft, setRepoDraft] = useState(repo);
  const [tokenDraft, setTokenDraft] = useState('');

  return (
    <div className="px-2 py-1">
      <label className="block px-1 mb-1 text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
        {t('pluginRepoLabel')}
      </label>
      <div className="flex gap-1.5 mb-2">
        <input
          value={repoDraft}
          onChange={(e) => setRepoDraft(e.target.value)}
          onBlur={() => setRepo(repoDraft)}
          placeholder={t('pluginRepoPh')}
          spellCheck={false}
          className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] text-[13px] outline-none focus:border-[var(--accent)]/50"
        />
        <button
          onClick={() => { setRepo(repoDraft); void sync(); }}
          disabled={syncing || !repoDraft.trim()}
          className="px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12px] font-medium hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 flex items-center gap-1.5 shrink-0"
        >
          <FiRefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
          {t('pluginSyncNow')}
        </button>
      </div>

      <label className="block px-1 mb-1 text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
        {t('pluginTokenLabel')}
      </label>
      <div className="flex gap-1.5 mb-1">
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
      {fetchedAt ? (
        <p className="px-1 mb-2 text-[11px] text-[var(--text-muted)]">
          {t('pluginLastSync')}: {new Date(fetchedAt).toLocaleString()} · {remote.length}
        </p>
      ) : null}
      {error ? (
        <p className="px-3 py-2 mb-2 rounded-xl bg-[var(--error)]/10 text-[12px] text-[var(--error)]">
          {t(ERR_KEYS[error] || 'pluginErrNet')}
        </p>
      ) : null}

      {Object.keys(origins).length > 0 && (
        <>
          <p className="px-1 mb-1 text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
            {t('pluginPushBack')}
          </p>
          {Object.entries(origins).map(([id, origin]) => {
            const changed = hasLocalChanges(id);
            const name = installedSkills.find((s) => s.id === id)?.name || id;
            return (
              <div key={id} className="flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-[var(--bg-2)] transition-colors">
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] text-[var(--text-primary)] truncate">{name}</p>
                  <p className="text-[11px] text-[var(--text-muted)] truncate">{origin.repo} · {origin.path}</p>
                </div>
                {changed ? (
                  <button
                    onClick={() => void pushSkill(id)}
                    disabled={pushing === id}
                    title={t('pluginPush')}
                    className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white transition-colors shrink-0 disabled:opacity-50 flex items-center gap-1"
                  >
                    <FiUpload size={11} />
                    {pushing === id ? t('pluginPushing') : t('pluginPush')}
                  </button>
                ) : (
                  <span className="text-[11px] text-[var(--success)] shrink-0">{t('pluginSynced')}</span>
                )}
              </div>
            );
          })}
        </>
      )}

      {remote.map((r) => {
        const installed = isInstalled(r.id);
        return (
          <div key={r.id} className="flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-[var(--bg-2)] transition-colors">
            <div className="flex-1 min-w-0">
              <p className="text-[13px] text-[var(--text-primary)] truncate">{r.name}</p>
              <p className="text-[11px] text-[var(--text-muted)] truncate">{r.description || r.path}</p>
            </div>
            <button
              onClick={() => void installRemote(r, rootPath ? 'project' : 'global')}
              title={t(installed ? 'pluginUpdate' : 'pluginInstall')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors shrink-0 flex items-center gap-1 ${
                installed
                  ? 'bg-[var(--bg-3)] text-[var(--text-secondary)] hover:bg-[var(--bg-4)]'
                  : 'bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white'
              }`}
            >
              <FiDownload size={11} />
              {t(installed ? 'pluginUpdate' : 'pluginInstall')}
            </button>
          </div>
        );
      })}
    </div>
  );
}
