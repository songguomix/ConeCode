import GithubAccountPanel from './GithubAccountPanel';
import GithubReleaseView from './GithubReleaseView';
import ReplyAssistantView from './ReplyAssistantView';
import { useEffect, useState } from 'react';
import { FiGitBranch, FiRefreshCw, FiUpload } from 'react-icons/fi';
import { useGithubPushStore } from '../../stores/githubPush.store';
import { useMarketStore } from '../../stores/market.store';
import { useLanguageStore, useWorkspaceStore } from '../../stores';

const inputClass = 'min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-2.5 py-1.5 text-xs outline-none focus:border-[var(--accent)]';
const buttonClass = 'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs transition-colors hover:bg-[var(--bg-3)] disabled:cursor-not-allowed disabled:opacity-50';

function LocalBranchForm({ root }: { root: string }) {
  const { t } = useLanguageStore();
  const refreshProject = useMarketStore((s) => s.refresh);
  const [branches, setBranches] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [base, setBase] = useState('');
  const [checkout, setCheckout] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const loadBranches = async () => {
    try {
      const out = await window.electronAPI.git.localBranches(root);
      if (out.ok) {
        setBranches(out.branches);
      } else {
        setResult({ ok: false, message: out.message || t('githubBranchesFailed') });
      }
    } catch {
      setResult({ ok: false, message: t('githubBranchesFailed') });
    }
  };

  const createBranch = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const out = await window.electronAPI.git.createBranch({ cwd: root, name: name.trim(), base: base || undefined, checkout });
      setResult(out);
      if (out.ok) {
        setName('');
        await Promise.all([loadBranches(), refreshProject()]);
      }
    } catch {
      setResult({ ok: false, message: t('githubBranchCreateFailed') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="mb-2 rounded-xl border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2"
      onToggle={(event) => { if (event.currentTarget.open) void loadBranches(); }}>
      <summary className="cursor-pointer text-xs font-medium">{t('githubCreateLocalBranch')}</summary>
      <form className="mt-2 space-y-2" onSubmit={(event) => { event.preventDefault(); void createBranch(); }}>
        <div className="grid gap-2 min-[520px]:grid-cols-2">
          <label className="block min-w-0 text-xs">
            {t('githubBranchName')}
            <input className={inputClass + ' mt-1 block w-full'} value={name} onChange={(event) => setName(event.target.value)}
              placeholder="feature/my-branch" autoComplete="off" spellCheck={false} required />
          </label>
          <label className="block min-w-0 text-xs">
            {t('githubBranchBase')}
            <select className={inputClass + ' mt-1 block w-full'} value={base} onChange={(event) => setBase(event.target.value)}>
              <option value="">{t('githubCurrentCommit')}</option>
              {branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs">
            <input type="checkbox" checked={checkout} onChange={(event) => setCheckout(event.target.checked)} />
            {t('githubBranchCheckout')}
          </label>
          <button type="submit" className={buttonClass} disabled={busy || !name.trim()}>
            <FiGitBranch size={12} aria-hidden="true" />
            {t(busy ? 'githubBranchCreating' : 'githubCreateLocalBranch')}
          </button>
        </div>
        {result && <p role="status" className={'break-words text-xs ' + (result.ok ? 'text-[var(--success)]' : 'text-[var(--error)]')}>{result.message}</p>}
      </form>
    </details>
  );
}

export default function SyncView() {
  const repo = useMarketStore((s) => s.repo);
  const repos = useMarketStore((s) => s.repos);
  const setRepo = useMarketStore((s) => s.setRepo);
  const addRepo = useMarketStore((s) => s.addRepo);
  const removeRepo = useMarketStore((s) => s.removeRepo);
  const status = useMarketStore((s) => s.status);
  const refreshing = useMarketStore((s) => s.refreshing);
  const pushing = useMarketStore((s) => s.pushing);
  const result = useMarketStore((s) => s.result);
  const lastPushAt = useMarketStore((s) => s.lastPushAt);
  const refresh = useMarketStore((s) => s.refresh);
  const pendingPush = useGithubPushStore((s) => s.pending);
  const requestPush = useGithubPushStore((s) => s.request);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const { t } = useLanguageStore();
  const [repoDraft, setRepoDraft] = useState('');
  const [repoError, setRepoError] = useState(false);
  const [tab, setTab] = useState<'push' | 'reply'>('push');
  const repoOptions = repo && !repos.includes(repo) ? [repo, ...repos] : repos;

  useEffect(() => { void refresh(); }, [refresh, rootPath]);

  return (
    <div className="min-w-0 px-2 py-1">
      <div className="mb-3 space-y-2">
        <label className="block text-xs font-medium">
          {t('githubRepoPresets')}
          <select className={inputClass + ' mt-1 block w-full'} value={repo} onChange={(event) => setRepo(event.target.value)}>
            <option value="">{t('githubRepoOrigin')}</option>
            {repoOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <form className="flex flex-wrap gap-1.5" onSubmit={(event) => {
          event.preventDefault();
          if (addRepo(repoDraft)) {
            setRepoDraft('');
            setRepoError(false);
          } else {
            setRepoError(true);
          }
        }}>
          <input value={repoDraft} aria-label={t('githubRepoAdd')} placeholder="owner/repo"
            onChange={(event) => { setRepoDraft(event.target.value); setRepoError(false); }}
            autoComplete="off" spellCheck={false} className={inputClass + ' flex-1 basis-36'} />
          <button type="submit" disabled={!repoDraft.trim()} className={buttonClass}>{t('githubRepoAdd')}</button>
          {repo && <button type="button" onClick={() => removeRepo(repo)} className={buttonClass}>{t('githubRepoRemove')}</button>}
        </form>
        {repoError && <p role="alert" className="text-xs text-[var(--error)]">{t('githubRepoInvalid')}</p>}
      </div>

      <GithubAccountPanel />

      <div role="tablist" aria-label={t('githubPluginSections')}
        className="mb-2 flex gap-1 rounded-xl border border-[var(--border)] bg-[var(--bg-2)] p-0.5">
        {(['push', 'reply'] as const).map((value) => (
          <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)}
            className={'flex-1 cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ' + (
              tab === value ? 'bg-[var(--bg-4)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            )}>
            {t(value === 'push' ? 'replyTabPush' : 'replyTabReply')}
          </button>
        ))}
      </div>

      {tab === 'reply' ? (
        <ReplyAssistantView onConfigureRepo={() => setTab('push')} />
      ) : (
        <>
          <div className="mb-2 flex min-w-0 items-start justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2">
            <p className="min-w-0 break-words py-1 text-xs text-[var(--text-secondary)] [overflow-wrap:anywhere]">
              {!rootPath ? t('pluginNoProject') : refreshing ? t('pluginChecking') : status?.isRepo ? (
                <>{t('pluginBranch')} <span className="font-mono text-[var(--text-primary)]">{status.branch}</span>
                  {' · '}{status.dirty > 0 ? status.dirty + ' ' + t('pluginChanges') : t('pluginClean')}</>
              ) : status ? t('pluginNotGit') : t('githubBranchesFailed')}
            </p>
            {rootPath && <button type="button" onClick={() => void refresh()} disabled={refreshing} aria-label={t('pluginRefresh')} title={t('pluginRefresh')} className={buttonClass}>
              <FiRefreshCw size={12} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
            </button>}
          </div>

          {rootPath && status?.isRepo && <LocalBranchForm key={rootPath} root={rootPath} />}

          <button type="button" onClick={() => { if (rootPath) void requestPush(undefined, { root: rootPath, repo }); }}
            disabled={!rootPath || refreshing || !status?.isRepo || pushing || !!pendingPush}
            className="mb-2 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50">
            <FiUpload size={13} aria-hidden="true" />
            {t(pushing ? 'pluginPushing' : 'githubPushReview')}
          </button>
          {result && <p role="status" className={'mb-2 break-words rounded-xl px-3 py-2 text-xs [overflow-wrap:anywhere] ' + (
            result.ok ? 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]' : 'bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error)]'
          )}>{result.message}</p>}
          {lastPushAt && <p className="break-words px-1 text-[11px] text-[var(--text-muted)] [overflow-wrap:anywhere]">
            {t('pluginLastPush')} {new Date(lastPushAt).toLocaleString()}
          </p>}
          <GithubReleaseView />
        </>
      )}
    </div>
  );
}
