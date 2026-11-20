import { useEffect, useRef, useState } from 'react';
import { useGithubPushStore } from '../../stores/githubPush.store';
import { loadGithubToken, normalizeRepo, useMarketStore } from '../../stores/market.store';
import { useLanguageStore } from '../../stores/language.store';
import type { GithubLocalBranches } from '../../types/github.types';
import './plugin-layout.css';

type PendingPush = NonNullable<ReturnType<typeof useGithubPushStore.getState>['pending']>;
const CUSTOM_REPO = 'custom';
const inputClass = 'mt-1 w-full min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg-0)] px-2.5 py-2 text-sm outline-none focus:border-[var(--accent)]';
const buttonClass = 'shrink-0 cursor-pointer rounded-lg border border-[var(--border)] px-3 py-2 text-sm transition-colors hover:bg-[var(--bg-2)] disabled:cursor-not-allowed disabled:opacity-40';

interface RemoteBranches {
  repo: string;
  loading: boolean;
  branches: string[];
  error?: string;
}

function PushForm({ pending }: { pending: PendingPush }) {
  const { t } = useLanguageStore();
  const repos = useMarketStore((s) => s.repos);
  const confirm = useGithubPushStore((s) => s.confirm);
  const cancel = useGithubPushStore((s) => s.cancel);
  const [repoChoice, setRepoChoice] = useState(pending.repo && !repos.includes(pending.repo) ? CUSTOM_REPO : pending.repo);
  const [customRepo, setCustomRepo] = useState(pending.repo);
  const [local, setLocal] = useState<GithubLocalBranches | null>(null);
  const [source, setSource] = useState(pending.sourceBranch || '');
  const [target, setTarget] = useState(pending.targetBranch || '');
  const [createTarget, setCreateTarget] = useState(!!pending.createTarget);
  const [remote, setRemote] = useState<RemoteBranches | null>(null);
  const remoteRequest = useRef(0);
  const rawRepo = (repoChoice === CUSTOM_REPO ? customRepo : repoChoice).trim();
  const repo = !rawRepo && repoChoice !== CUSTOM_REPO ? '' : normalizeRepo(rawRepo);
  const activeRemote = remote?.repo === repo ? remote : null;
  const branch = target.trim() || source;
  const destination = repo || local?.pushUrl || 'origin';
  const hasDestination = repo !== null && !!(repo || local?.pushUrl);
  const canPush = !!local?.ok && !!source && hasDestination;

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const info = await window.electronAPI.git.localBranches(pending.root);
        if (!live) return;
        setLocal(info);
        if (info.ok) {
          setSource((value) => value
            ? (info.branches.includes(value) || info.current === value ? value : '')
            : info.current || '');
        }
      } catch {
        if (live) setLocal({ ok: false, branches: [], current: null });
      }
    };
    void load();
    return () => { live = false; remoteRequest.current++; };
  }, [pending.root]);

  const loadRemote = async () => {
    if (repo === null) return;
    const request = ++remoteRequest.current;
    setRemote({ repo, loading: true, branches: [] });
    try {
      const result = await window.electronAPI.git.remoteBranches({
        cwd: pending.root,
        repo: repo || undefined,
        token: loadGithubToken() || undefined,
      });
      if (request === remoteRequest.current) {
        setRemote({ repo, loading: false, branches: result.branches, error: result.ok ? undefined : result.message || t('githubBranchesFailed') });
      }
    } catch {
      if (request === remoteRequest.current) setRemote({ repo, loading: false, branches: [], error: t('githubBranchesFailed') });
    }
  };

  const localBranches = [...new Set([...(local?.current ? [local.current] : []), ...(local?.branches || [])])];
  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      if (canPush && repo !== null) confirm(repo, {
        sourceBranch: source,
        targetBranch: branch,
        createTarget,
        commitChanges: source === local?.current,
        originKey: repo === '' ? local?.originKey : undefined,
      });
    }} className="space-y-3">
      <div>
        <p className="mt-2 text-xs text-[var(--text-secondary)]">{t('githubPushSource')}</p>
        <p className="mt-1 break-all font-mono text-xs">{pending.root}</p>
      </div>

      <label className="block text-sm">
        {t('pluginRepoLabel')}
        <select className={inputClass} autoFocus value={repoChoice} onChange={(event) => setRepoChoice(event.target.value)}>
          <option value="">{local?.pushUrl ? t('githubRepoOrigin') + ' · ' + local.pushUrl : t('githubRepoOrigin')}</option>
          {repos.map((option) => <option key={option} value={option}>{option}</option>)}
          <option value={CUSTOM_REPO}>{t('githubRepoOther')}</option>
        </select>
      </label>
      {repoChoice === CUSTOM_REPO && <label className="block text-sm">
        {t('githubRepoOther')}
        <input className={inputClass} value={customRepo} onChange={(event) => setCustomRepo(event.target.value)}
          placeholder="owner/repo" autoComplete="off" spellCheck={false} required />
      </label>}
      {rawRepo && repo === null && <p role="alert" className="text-xs text-[var(--error)]">{t('githubRepoInvalid')}</p>}
      {local?.ok && repo === '' && !local.pushUrl && <p role="alert" className="text-xs text-[var(--error)]">{t('githubRepoNoOrigin')}</p>}

      <label className="block text-sm">
        {t('githubPushLocalBranch')}
        <select className={inputClass} value={source} onChange={(event) => setSource(event.target.value)} disabled={!local?.ok}>
          {!source && <option value="">{t(local ? 'githubSelectLocalBranch' : 'pluginChecking')}</option>}
          {localBranches.map((name) => <option key={name} value={name}>
            {name === local?.current ? name + ' · ' + t('githubCurrentBranch') : name}
          </option>)}
        </select>
      </label>
      {local && !local.ok && <p role="alert" className="break-words text-xs text-[var(--error)]">{local.message || t('githubBranchesFailed')}</p>}

      <div>
        <label className="block text-sm">
          {t('githubPushRemoteBranch')}
          <input className={inputClass} list="github-push-remote-branches" value={target} onChange={(event) => setTarget(event.target.value)}
            placeholder={source || 'feature/my-branch'} autoComplete="off" spellCheck={false} />
        </label>
        <datalist id="github-push-remote-branches">
          {activeRemote?.branches.map((name) => <option key={name} value={name} />)}
        </datalist>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button type="button" className="shrink-0 cursor-pointer rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs transition-colors hover:bg-[var(--bg-2)] disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!hasDestination || !local?.ok || activeRemote?.loading} onClick={() => void loadRemote()}>
            {t(activeRemote?.loading ? 'pluginChecking' : 'githubLoadRemoteBranches')}
          </button>
          {activeRemote && !activeRemote.loading && !activeRemote.error && (
            <span role="status" className="text-xs text-[var(--text-muted)]">{t(activeRemote.branches.length ? 'githubRemoteBranchesLoaded' : 'githubRemoteBranchesEmpty')}</span>
          )}
        </div>
        {activeRemote?.error && <p role="status" className="mt-1.5 break-words text-xs text-[var(--error)]">{activeRemote.error}</p>}
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <input type="checkbox" checked={createTarget} onChange={(event) => setCreateTarget(event.target.checked)} />
        {t('githubPushCreateRemote')}
      </label>

      {source && <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-2.5 py-2">
        <p className="break-all font-mono text-xs">{source} → {destination} · {branch}</p>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          {t(source === local?.current ? 'githubPushConfirmCurrent' : 'githubPushConfirmOther')}
        </p>
      </div>}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <button type="button" onClick={cancel} className={buttonClass}>{t('cancel')}</button>
        <button type="submit" disabled={!canPush} className="cursor-pointer rounded-lg bg-[var(--accent)] px-3 py-2 text-sm text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40">
          {t('pluginPushProject')}
        </button>
      </div>
    </form>
  );
}

export default function GithubPushDialog() {
  const pending = useGithubPushStore((s) => s.pending);
  const cancel = useGithubPushStore((s) => s.cancel);
  const { t } = useLanguageStore();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (pending && !dialog?.open) dialog?.showModal();
    else if (!pending) dialog?.close();
  }, [pending]);

  return (
    <dialog ref={dialogRef} onCancel={cancel} aria-labelledby="github-push-title"
      className="plugin-dialog m-auto w-[min(480px,calc(100vw-32px))] rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-surface)] p-5 text-[var(--text-primary)] shadow-2xl ring-1 ring-black/5 backdrop:bg-black/50 backdrop:backdrop-blur-sm dark:ring-white/10">
      <h2 id="github-push-title" className="font-serif text-base font-bold tracking-tight">{t('githubPushReview')}</h2>
      {pending && <PushForm pending={pending} />}
    </dialog>
  );
}
